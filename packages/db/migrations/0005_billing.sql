-- Fase 5: planos, assinaturas, cobranças e eventos do provedor de pagamento.
-- Nenhum dado de cartão é armazenado: o pagamento acontece na página do
-- provedor, e aqui ficam só referências, valores, datas e situações.

CREATE TYPE subscription_status AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED');
CREATE TYPE invoice_status      AS ENUM ('OPEN', 'PAID', 'FAILED', 'VOID');

-- Planos: catálogo global da plataforma (não pertence a uma empresa).
CREATE TABLE plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]{2,40}$'),
  name             text NOT NULL CHECK (length(trim(name)) > 0),
  description      text,
  price_cents      int  NOT NULL CHECK (price_cents > 0),
  currency         char(3) NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  billing_interval text NOT NULL DEFAULT 'MONTH' CHECK (billing_interval = 'MONTH'),
  max_users        int CHECK (max_users IS NULL OR max_users > 0),
  max_units        int CHECK (max_units IS NULL OR max_units > 0),
  active           boolean NOT NULL DEFAULT true,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz(3) NOT NULL DEFAULT now()
);

-- Assinatura da empresa. Preço e limites são copiados do plano na contratação:
-- mudar o plano depois não altera o que já foi contratado.
CREATE TABLE subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  plan_id                uuid NOT NULL REFERENCES plans(id),
  plan_name              text NOT NULL,
  price_cents            int  NOT NULL CHECK (price_cents > 0),
  max_users              int,
  max_units              int,
  status                 subscription_status NOT NULL DEFAULT 'ACTIVE',
  -- Dias de tolerância depois do vencimento, definidos na contratação (sem valor padrão).
  grace_days             int NOT NULL CHECK (grace_days BETWEEN 0 AND 90),
  provider               text NOT NULL,
  provider_customer_ref  text,
  provider_subscription_ref text,
  current_period_end     date,
  canceled_at            timestamptz(3),
  cancel_reason          text,
  created_by             uuid NOT NULL REFERENCES users(id),
  created_at             timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider, provider_subscription_ref)
);
-- Uma assinatura não cancelada por empresa.
CREATE UNIQUE INDEX subscriptions_one_open ON subscriptions (tenant_id) WHERE status <> 'CANCELED';

CREATE TABLE invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  subscription_id     uuid NOT NULL,
  amount_cents        int  NOT NULL CHECK (amount_cents > 0),
  due_date            date NOT NULL,
  status              invoice_status NOT NULL DEFAULT 'OPEN',
  provider_charge_ref text NOT NULL,
  provider            text NOT NULL,
  paid_at             timestamptz(3),
  failure_reason      text,
  -- Link do comprovante no provedor, quando ele oferece.
  receipt_url         text CHECK (receipt_url IS NULL OR receipt_url ~ '^https://'),
  created_at          timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions (tenant_id, id),
  UNIQUE (provider, provider_charge_ref)
);
CREATE INDEX invoices_tenant ON invoices (tenant_id, due_date);

-- Caixa de entrada de webhooks: só campos normalizados e o hash do corpo
-- recebido (nunca o corpo bruto). O par (provedor, id do evento) impede
-- processar duas vezes o mesmo aviso.
CREATE TABLE billing_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  provider       text NOT NULL,
  event_id       text NOT NULL,
  type           text NOT NULL,
  data           jsonb NOT NULL,
  body_sha256    char(64) NOT NULL,
  received_at    timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

ALTER TABLE plans          ENABLE ROW LEVEL SECURITY;
-- subscriptions e invoices: ENABLE sem FORCE, como tenants. O app continua
-- filtrado pelas políticas; só as funções SECURITY DEFINER abaixo leem todas
-- (para localizar a empresa de um webhook e reavaliar vencimentos).
ALTER TABLE subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE  ROW LEVEL SECURITY;

-- Catálogo visível a todos; só o administrador da plataforma cria e altera.
CREATE POLICY plans_select ON plans FOR SELECT USING (true);
CREATE POLICY plans_insert ON plans FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = app_user_id()));
CREATE POLICY plans_update ON plans FOR UPDATE
  USING (EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = app_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = app_user_id()));

CREATE POLICY subscriptions_all ON subscriptions FOR ALL
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY invoices_all ON invoices FOR ALL
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY billing_events_all ON billing_events FOR ALL
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Preço e limites contratados não mudam depois de criados.
CREATE FUNCTION subscriptions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assinatura não pode ser apagada' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.plan_id <> OLD.plan_id OR NEW.price_cents <> OLD.price_cents
     OR NEW.max_users IS DISTINCT FROM OLD.max_users OR NEW.max_units IS DISTINCT FROM OLD.max_units
     OR NEW.created_at <> OLD.created_at OR NEW.provider <> OLD.provider THEN
    RAISE EXCEPTION 'condições contratadas não podem ser alteradas' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'CANCELED' THEN
    RAISE EXCEPTION 'assinatura cancelada não pode ser alterada; crie outra' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscriptions_guard BEFORE UPDATE OR DELETE ON subscriptions FOR EACH ROW EXECUTE FUNCTION subscriptions_guard();

CREATE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cobrança não pode ser apagada' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_cents <> OLD.amount_cents OR NEW.due_date <> OLD.due_date OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.provider_charge_ref <> OLD.provider_charge_ref OR NEW.subscription_id <> OLD.subscription_id THEN
    RAISE EXCEPTION 'valor e vencimento da cobrança não podem ser alterados' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('PAID', 'VOID') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'cobrança paga ou anulada não muda de situação' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_guard();
CREATE TRIGGER billing_events_immutable BEFORE UPDATE OR DELETE ON billing_events FOR EACH ROW EXECUTE FUNCTION immutable_row();

-- Localiza a empresa de uma assinatura do provedor (webhook chega sem empresa).
CREATE FUNCTION billing_resolve_tenant(p_provider text, p_subscription_ref text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id FROM subscriptions WHERE provider = p_provider AND provider_subscription_ref = p_subscription_ref
$$;

-- Situação comercial da empresa a partir das cobranças. Regras:
--  * sem assinatura: não mexe (empresas piloto ou situação definida manualmente);
--  * empresa ENCERRADA (CLOSED) só muda por ação do administrador da plataforma;
--  * nada em atraso → ACTIVE; atraso dentro da tolerância → GRACE_PERIOD;
--    além da tolerância, ou assinatura cancelada com período encerrado → READ_ONLY.
-- Nunca apaga dados nem passa para CLOSED sozinha.
CREATE FUNCTION billing_sync_tenant(p_tenant uuid)
RETURNS tenant_status LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev text := current_setting('app.tenant_id', true);
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_sub subscriptions%ROWTYPE;
  v_oldest date;
  v_current tenant_status;
  v_new tenant_status;
BEGIN
  SELECT status INTO v_current FROM tenants WHERE id = p_tenant FOR UPDATE;
  IF v_current IS NULL OR v_current = 'CLOSED' THEN RETURN v_current; END IF;
  SELECT * INTO v_sub FROM subscriptions WHERE tenant_id = p_tenant ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN v_current; END IF;

  SELECT min(due_date) INTO v_oldest FROM invoices
   WHERE tenant_id = p_tenant AND subscription_id = v_sub.id AND status IN ('OPEN', 'FAILED') AND due_date < v_today;

  IF v_sub.status = 'CANCELED' THEN
    v_new := CASE WHEN v_sub.current_period_end IS NOT NULL AND v_sub.current_period_end >= v_today AND v_oldest IS NULL
                  THEN 'ACTIVE' ELSE 'READ_ONLY' END;
  ELSIF v_oldest IS NULL THEN
    v_new := 'ACTIVE';
  ELSIF v_today <= v_oldest + v_sub.grace_days THEN
    v_new := 'GRACE_PERIOD';
  ELSE
    v_new := 'READ_ONLY';
  END IF;

  IF v_sub.status <> 'CANCELED' THEN
    UPDATE subscriptions SET status = CASE WHEN v_oldest IS NULL THEN 'ACTIVE' ELSE 'PAST_DUE' END::subscription_status
     WHERE id = v_sub.id AND status <> CASE WHEN v_oldest IS NULL THEN 'ACTIVE' ELSE 'PAST_DUE' END::subscription_status;
  END IF;
  IF v_new <> v_current THEN
    UPDATE tenants SET status = v_new WHERE id = p_tenant;
    -- A auditoria tem RLS forçada: grava no contexto da própria empresa.
    PERFORM set_config('app.tenant_id', p_tenant::text, true);
    INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, data)
    VALUES (p_tenant, NULL, 'tenant.status_billing', 'tenant', p_tenant,
            jsonb_build_object('from', v_current, 'to', v_new, 'oldestOverdue', v_oldest, 'graceDays', v_sub.grace_days));
    PERFORM set_config('app.tenant_id', COALESCE(v_prev, ''), true);
  END IF;
  RETURN v_new;
END $$;

-- Roda a sincronização em todas as empresas com assinatura (agendada na API).
CREATE FUNCTION billing_sync_all() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT DISTINCT tenant_id FROM subscriptions LOOP
    PERFORM billing_sync_tenant(r.tenant_id);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- Visão comercial para o administrador da plataforma: dados de contrato e
-- CONTAGENS de uso. Nenhum conteúdo de APR, PT, pessoas ou locais.
CREATE FUNCTION platform_billing_overview()
RETURNS TABLE (tenant_id uuid, legal_name text, trade_name text, cnpj char(14), tenant_status tenant_status,
               subscription_id uuid, plan_name text, price_cents int, subscription_status subscription_status,
               grace_days int, max_users int, max_units int, overdue_cents bigint,
               active_users bigint, units bigint, aprs bigint, work_permits bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev text := current_setting('app.tenant_id', true);
  t record;
  s record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = app_user_id()) THEN
    RAISE EXCEPTION 'restrito ao administrador da plataforma' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR t IN SELECT * FROM tenants ORDER BY created_at LOOP
    -- Tabelas de conteúdo têm RLS forçada: as contagens rodam no contexto da empresa.
    PERFORM set_config('app.tenant_id', t.id::text, true);
    SELECT * INTO s FROM subscriptions s2 WHERE s2.tenant_id = t.id ORDER BY s2.created_at DESC LIMIT 1;
    tenant_id := t.id; legal_name := t.legal_name; trade_name := t.trade_name; cnpj := t.cnpj; tenant_status := t.status;
    subscription_id := s.id; plan_name := s.plan_name; price_cents := s.price_cents; subscription_status := s.status;
    grace_days := s.grace_days; max_users := s.max_users; max_units := s.max_units;
    overdue_cents := COALESCE((SELECT sum(i.amount_cents) FROM invoices i WHERE i.tenant_id = t.id AND i.status IN ('OPEN', 'FAILED')
                      AND i.due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date), 0);
    active_users := (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'ACTIVE');
    units := (SELECT count(*) FROM units u WHERE u.tenant_id = t.id);
    aprs := (SELECT count(*) FROM aprs a WHERE a.tenant_id = t.id);
    work_permits := (SELECT count(*) FROM work_permits w WHERE w.tenant_id = t.id);
    RETURN NEXT;
    s := NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id', COALESCE(v_prev, ''), true);
END $$;

GRANT USAGE ON TYPE subscription_status, invoice_status TO sitedopai_app;
GRANT SELECT, INSERT, UPDATE ON plans, subscriptions, invoices TO sitedopai_app;
GRANT SELECT, INSERT ON billing_events TO sitedopai_app;
REVOKE ALL ON FUNCTION billing_resolve_tenant(text, text), billing_sync_tenant(uuid), billing_sync_all(), platform_billing_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_resolve_tenant(text, text), billing_sync_tenant(uuid), billing_sync_all(), platform_billing_overview() TO sitedopai_app;
