-- 0001_init — Fase 1: estrutura multiempresa, RLS e trilha de auditoria.
-- Executada como sitedopai_owner. Ver docs/modelo-de-dados.md.

-- ---------------------------------------------------------------------------
-- Contexto da sessão: preenchido pela API em cada transação (SET LOCAL).
-- Sem valor, as funções retornam NULL e as políticas não deixam ver nada.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
CREATE TYPE tenant_status     AS ENUM ('ACTIVE', 'GRACE_PERIOD', 'READ_ONLY', 'CLOSED');
CREATE TYPE membership_status AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');
CREATE TYPE role_name         AS ENUM ('COMPANY_ADMIN', 'SST', 'SUPERVISOR', 'EXECUTOR', 'AUDITOR');
CREATE TYPE scope_type        AS ENUM ('TENANT', 'UNIT');

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name  text NOT NULL CHECK (length(trim(legal_name)) > 0),
  trade_name  text,
  cnpj        char(14) NOT NULL UNIQUE CHECK (cnpj ~ '^[0-9]{14}$'),
  status      tenant_status NOT NULL DEFAULT 'ACTIVE',
  created_at  timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_subject  text UNIQUE,
  email         text NOT NULL UNIQUE CHECK (email = lower(email) AND email LIKE '%@%'),
  display_name  text NOT NULL,
  created_at    timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE platform_admins (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  created_at  timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  code        text NOT NULL CHECK (length(trim(code)) > 0),
  city        text,
  state       char(2),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz(3) NOT NULL DEFAULT now(),
  updated_at  timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE sectors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  unit_id     uuid NOT NULL,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, unit_id, name),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE contractors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  legal_name  text NOT NULL,
  cnpj        char(14) NOT NULL CHECK (cnpj ~ '^[0-9]{14}$'),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, cnpj)
);

CREATE TABLE memberships (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  contractor_id  uuid,
  status         membership_status NOT NULL DEFAULT 'INVITED',
  created_at     timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES contractors (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE role_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  membership_id  uuid NOT NULL,
  role           role_name NOT NULL,
  scope_type     scope_type NOT NULL,
  unit_id        uuid,
  created_at     timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units (tenant_id, id) ON DELETE RESTRICT,
  CHECK ((scope_type = 'TENANT' AND unit_id IS NULL) OR (scope_type = 'UNIT' AND unit_id IS NOT NULL)),
  CHECK (role <> 'COMPANY_ADMIN' OR scope_type = 'TENANT')
);
CREATE UNIQUE INDEX role_assignments_unique_scope
  ON role_assignments (tenant_id, membership_id, role, scope_type, COALESCE(unit_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE audit_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  seq            bigint NOT NULL,
  occurred_at    timestamptz(3) NOT NULL DEFAULT now(),
  actor_user_id  uuid REFERENCES users(id) ON DELETE RESTRICT,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash      char(64) NOT NULL,
  hash           char(64) NOT NULL,
  UNIQUE (tenant_id, seq)
);

-- ---------------------------------------------------------------------------
-- Gatilhos
-- ---------------------------------------------------------------------------
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER units_touch BEFORE UPDATE ON units FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Hash de um evento de auditoria. Mesma fórmula usada na verificação.
CREATE FUNCTION audit_hash(
  p_prev char(64), p_tenant uuid, p_seq bigint, p_at timestamptz, p_actor uuid,
  p_action text, p_entity_type text, p_entity_id text, p_data jsonb
) RETURNS char(64) LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    p_prev, p_tenant::text, p_seq::text,
    to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    COALESCE(p_actor::text, ''), p_action, p_entity_type, COALESCE(p_entity_id, ''), p_data::text
  ), 'UTF8')), 'hex')
$$;

-- Preenche seq, prev_hash e hash. O lock por empresa serializa inserções
-- concorrentes da mesma empresa sem bloquear as demais.
CREATE FUNCTION audit_events_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq  bigint;
  last_hash char(64);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || NEW.tenant_id::text, 0));
  SELECT seq, hash INTO last_seq, last_hash
    FROM audit_events WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  NEW.seq         := COALESCE(last_seq, 0) + 1;
  NEW.prev_hash   := COALESCE(last_hash, repeat('0', 64));
  NEW.occurred_at := date_trunc('milliseconds', clock_timestamp());
  NEW.hash := audit_hash(NEW.prev_hash, NEW.tenant_id, NEW.seq, NEW.occurred_at, NEW.actor_user_id,
                         NEW.action, NEW.entity_type, NEW.entity_id, NEW.data);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_chain();

CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_events é somente inserção' USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- Recalcula a cadeia da empresa ativa. Retorna NULL se íntegra, ou o seq do
-- primeiro evento com problema (hash divergente, elo quebrado ou lacuna).
CREATE FUNCTION audit_verify() RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_events%ROWTYPE;
  expected_prev char(64) := repeat('0', 64);
  expected_seq bigint := 1;
BEGIN
  FOR r IN SELECT * FROM audit_events WHERE tenant_id = app_tenant_id() ORDER BY seq LOOP
    IF r.seq <> expected_seq OR r.prev_hash <> expected_prev OR r.hash <> audit_hash(
         r.prev_hash, r.tenant_id, r.seq, r.occurred_at, r.actor_user_id,
         r.action, r.entity_type, r.entity_id, r.data) THEN
      RETURN r.seq;
    END IF;
    expected_prev := r.hash;
    expected_seq := expected_seq + 1;
  END LOOP;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE tenants          ENABLE ROW LEVEL SECURITY;
ALTER TABLE units            ENABLE ROW LEVEL SECURITY;
ALTER TABLE units            FORCE  ROW LEVEL SECURITY;
ALTER TABLE sectors          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sectors          FORCE  ROW LEVEL SECURITY;
ALTER TABLE contractors      ENABLE ROW LEVEL SECURITY;
ALTER TABLE contractors      FORCE  ROW LEVEL SECURITY;
ALTER TABLE memberships      ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships      FORCE  ROW LEVEL SECURITY;
ALTER TABLE role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignments FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events     FORCE  ROW LEVEL SECURITY;
-- tenants, users e platform_admins: ENABLE sem FORCE. O app é filtrado pelas políticas;
-- só as funções SECURITY DEFINER abaixo (donas: sitedopai_owner) passam por cima.
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins  ENABLE ROW LEVEL SECURITY;

-- Empresa: a ativa, ou as empresas em que o usuário tem vínculo (para listar).
CREATE POLICY tenants_select ON tenants FOR SELECT
  USING (id = app_tenant_id()
         OR id IN (SELECT m.tenant_id FROM memberships m WHERE m.user_id = app_user_id()));
CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK (id = app_tenant_id());
CREATE POLICY tenants_update ON tenants FOR UPDATE
  USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());

CREATE POLICY units_all ON units FOR ALL
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY sectors_all ON sectors FOR ALL
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY contractors_all ON contractors FOR ALL
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY role_assignments_all ON role_assignments FOR ALL
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Vínculos: escrita só na empresa ativa; leitura também dos próprios vínculos.
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (tenant_id = app_tenant_id() OR user_id = app_user_id());
CREATE POLICY memberships_insert ON memberships FOR INSERT WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY memberships_delete ON memberships FOR DELETE USING (tenant_id = app_tenant_id());

-- Papéis do próprio usuário em qualquer empresa (necessário para montar a sessão).
CREATE POLICY role_assignments_self ON role_assignments FOR SELECT
  USING (membership_id IN (SELECT m.id FROM memberships m WHERE m.user_id = app_user_id()));

CREATE POLICY audit_select ON audit_events FOR SELECT USING (tenant_id = app_tenant_id());
CREATE POLICY audit_insert ON audit_events FOR INSERT WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY users_select ON users FOR SELECT
  USING (id = app_user_id()
         OR id IN (SELECT m.user_id FROM memberships m WHERE m.tenant_id = app_tenant_id()));

CREATE POLICY platform_admins_self ON platform_admins FOR SELECT USING (user_id = app_user_id());

-- ---------------------------------------------------------------------------
-- Funções privilegiadas (SECURITY DEFINER), com escopo mínimo
-- ---------------------------------------------------------------------------

-- Resolve o usuário do token OIDC. Vincula o subject a um convite pelo e-mail
-- somente se o e-mail foi verificado pelo provedor. Não cria usuários.
CREATE FUNCTION auth_resolve_user(p_subject text, p_email text, p_email_verified boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid;
BEGIN
  SELECT id INTO uid FROM users WHERE oidc_subject = p_subject;
  IF uid IS NOT NULL THEN RETURN uid; END IF;
  IF p_email_verified AND p_email IS NOT NULL THEN
    UPDATE users SET oidc_subject = p_subject
      WHERE email = lower(p_email) AND oidc_subject IS NULL
      RETURNING id INTO uid;
  END IF;
  RETURN uid;
END $$;

-- Garante um usuário para o e-mail convidado e devolve o id, sem expor outros dados.
-- Exige empresa ativa no contexto.
CREATE FUNCTION invite_user(p_email text, p_display_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid;
BEGIN
  IF app_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'empresa ativa obrigatória' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO users (email, display_name) VALUES (lower(p_email), p_display_name)
    ON CONFLICT (email) DO NOTHING;
  SELECT id INTO uid FROM users WHERE email = lower(p_email);
  RETURN uid;
END $$;

-- Lista empresas com dados comerciais apenas, para o administrador da plataforma.
-- Lê só a tabela tenants (sem FORCE): nenhuma tabela de conteúdo é acessada.
-- Contagens agregadas de uso ficam para a Fase 5.
CREATE FUNCTION platform_list_tenants()
RETURNS TABLE (id uuid, legal_name text, trade_name text, cnpj char(14), status tenant_status,
               created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = app_user_id()) THEN
    RAISE EXCEPTION 'restrito ao administrador da plataforma' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT t.id, t.legal_name, t.trade_name, t.cnpj, t.status, t.created_at
      FROM tenants t ORDER BY t.created_at;
END $$;

-- ---------------------------------------------------------------------------
-- Permissões do papel da aplicação
-- ---------------------------------------------------------------------------
GRANT USAGE ON TYPE tenant_status, membership_status, role_name, scope_type TO sitedopai_app;
GRANT SELECT, INSERT, UPDATE ON tenants TO sitedopai_app;
GRANT SELECT ON users, platform_admins TO sitedopai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON units, sectors, contractors, memberships, role_assignments TO sitedopai_app;
GRANT SELECT, INSERT ON audit_events TO sitedopai_app;
REVOKE ALL ON FUNCTION auth_resolve_user(text, text, boolean), invite_user(text, text), platform_list_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_user(text, text, boolean), invite_user(text, text), platform_list_tenants() TO sitedopai_app;
GRANT EXECUTE ON FUNCTION app_tenant_id(), app_user_id(), audit_verify(), audit_hash(char, uuid, bigint, timestamptz, uuid, text, text, text, jsonb) TO sitedopai_app;
