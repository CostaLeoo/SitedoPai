-- 0004_documents — Fase 4: documentos emitidos (PDF), verificação pública,
-- regras de guarda e retenção por litígio/investigação.
-- Nada aqui apaga documentos. Descarte exige procedimento ainda a definir.

CREATE TYPE retention_source AS ENUM ('LEGAL', 'CONTRACT', 'INTERNAL');

-- Cada emissão gera um registro imutável. O PDF fica no armazenamento em modo
-- "gravar uma vez"; o hash permite conferir qualquer cópia.
CREATE TABLE issued_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_type      text NOT NULL CHECK (document_type IN ('apr', 'work_permit')),
  document_id        uuid NOT NULL,
  document_number    text NOT NULL,
  document_revision  int  NOT NULL DEFAULT 0,
  sequence           int  NOT NULL,
  status_at_issue    text NOT NULL,
  sha256             char(64) NOT NULL,
  size_bytes         int NOT NULL CHECK (size_bytes > 0),
  storage_key        text NOT NULL,
  verification_code  text NOT NULL UNIQUE CHECK (verification_code ~ '^[A-Z2-7]{24}$'),
  issued_by          uuid NOT NULL REFERENCES users(id),
  issued_at          timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_type, document_id, sequence)
);
CREATE INDEX issued_documents_doc ON issued_documents (tenant_id, document_type, document_id);

-- Regras de guarda configuradas pela empresa (com o jurídico). Sem regra
-- aplicável, o documento fica sob guarda indefinida.
CREATE TABLE retention_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_type   text NOT NULL CHECK (document_type IN ('apr', 'work_permit')),
  pt_type_name    text,
  min_years       int  NOT NULL CHECK (min_years BETWEEN 1 AND 100),
  source          retention_source NOT NULL,
  basis           text NOT NULL CHECK (length(trim(basis)) > 0),
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  deactivated_by  uuid REFERENCES users(id),
  deactivated_at  timestamptz(3),
  UNIQUE (tenant_id, id),
  CHECK (pt_type_name IS NULL OR document_type = 'work_permit')
);

-- Retenção especial (litígio, investigação, fiscalização): suspende qualquer descarte.
CREATE TABLE legal_holds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_type   text NOT NULL CHECK (document_type IN ('apr', 'work_permit')),
  document_id     uuid NOT NULL,
  reason          text NOT NULL CHECK (length(trim(reason)) > 0),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  released_by     uuid REFERENCES users(id),
  released_at     timestamptz(3),
  release_reason  text,
  UNIQUE (tenant_id, id),
  CHECK ((released_at IS NULL) = (released_by IS NULL)),
  CHECK (released_at IS NULL OR release_reason IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Imutabilidade
-- ---------------------------------------------------------------------------
CREATE TRIGGER issued_documents_immutable BEFORE UPDATE OR DELETE ON issued_documents FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER issued_documents_no_truncate BEFORE TRUNCATE ON issued_documents FOR EACH STATEMENT EXECUTE FUNCTION immutable_row();

-- Regra de origem LEGAL não é desativada (prazo efetivo nunca abaixo do legal);
-- as demais só podem ser desativadas, uma vez. Nada é apagado.
CREATE FUNCTION retention_rules_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'regra de guarda não pode ser apagada; desative-a' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['active', 'deactivated_by', 'deactivated_at']) <> (to_jsonb(OLD) - ARRAY['active', 'deactivated_by', 'deactivated_at'])
     OR NOT OLD.active OR NEW.active THEN
    RAISE EXCEPTION 'regra de guarda só pode ser desativada, uma vez' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.source = 'LEGAL' THEN
    RAISE EXCEPTION 'regra de origem legal não pode ser desativada' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retention_rules_guard BEFORE UPDATE OR DELETE ON retention_rules FOR EACH ROW EXECUTE FUNCTION retention_rules_guard();

CREATE FUNCTION legal_holds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'retenção especial não pode ser apagada; libere-a com justificativa' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.released_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['released_by', 'released_at', 'release_reason']) <> (to_jsonb(OLD) - ARRAY['released_by', 'released_at', 'release_reason']) THEN
    RAISE EXCEPTION 'retenção especial só pode ser liberada, uma vez' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legal_holds_guard BEFORE UPDATE OR DELETE ON legal_holds FOR EACH ROW EXECUTE FUNCTION legal_holds_guard();

-- ---------------------------------------------------------------------------
-- Verificação pública pelo código do QR. Não exige login e não expõe dados
-- pessoais nem conteúdo: só identifica o documento, a empresa emissora, o hash
-- e a situação ATUAL (para a PT, se vale como autorização agora).
-- ---------------------------------------------------------------------------
CREATE FUNCTION verify_document(p_code text)
RETURNS TABLE (document_type text, document_number text, document_revision int, company text, issued_at timestamptz,
               sha256 char(64), status_at_issue text, current_status text, valid_from timestamptz, valid_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d issued_documents%ROWTYPE;
BEGIN
  IF p_code !~ '^[A-Z2-7]{24}$' THEN RETURN; END IF;
  SELECT * INTO d FROM issued_documents i WHERE i.verification_code = p_code;
  IF NOT FOUND THEN RETURN; END IF;
  -- Lê a situação atual com o contexto da empresa do documento (RLS continua valendo).
  PERFORM set_config('app.tenant_id', d.tenant_id::text, true);
  IF d.document_type = 'apr' THEN
    RETURN QUERY SELECT d.document_type, d.document_number, d.document_revision, COALESCE(t.trade_name, t.legal_name), d.issued_at,
      d.sha256, d.status_at_issue, a.status::text, NULL::timestamptz, NULL::timestamptz
      FROM aprs a JOIN tenants t ON t.id = a.tenant_id WHERE a.id = d.document_id;
  ELSE
    RETURN QUERY SELECT d.document_type, d.document_number, d.document_revision, COALESCE(t.trade_name, t.legal_name), d.issued_at,
      d.sha256, d.status_at_issue,
      CASE WHEN w.status IN ('RELEASED', 'IN_EXECUTION', 'SUSPENDED') AND w.ends_at <= clock_timestamp() THEN 'EXPIRED' ELSE w.status::text END,
      w.starts_at, w.ends_at
      FROM work_permits w JOIN tenants t ON t.id = w.tenant_id WHERE w.id = d.document_id;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RLS e permissões. issued_documents fica sem FORCE para a função de
-- verificação (dona do schema) localizar pelo código; o app continua filtrado.
-- ---------------------------------------------------------------------------
ALTER TABLE issued_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY issued_documents_tenant ON issued_documents FOR ALL USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['retention_rules', 'legal_holds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_tenant', t);
  END LOOP;
END $$;

GRANT USAGE ON TYPE retention_source TO sitedopai_app;
GRANT SELECT, INSERT ON issued_documents TO sitedopai_app;
GRANT SELECT, INSERT, UPDATE ON retention_rules, legal_holds TO sitedopai_app;
REVOKE ALL ON FUNCTION verify_document(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_document(text) TO sitedopai_app;
