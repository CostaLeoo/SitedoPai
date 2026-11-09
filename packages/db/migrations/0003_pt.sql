-- 0003_pt — Fase 3a: trabalhadores, qualificações, tipos de PT, Permissão de
-- Trabalho, equipe, checklist, medições atmosféricas, registro de entradas e
-- assinaturas eletrônicas. Valores normativos (validade, limites, funções e
-- treinamentos exigidos) são CONFIGURADOS por tipo de PT, nunca fixados aqui.

CREATE TYPE qualification_kind AS ENUM ('TRAINING', 'DESIGNATION', 'FITNESS', 'OTHER');
CREATE TYPE team_function      AS ENUM ('RESPONSIBLE', 'EXECUTOR', 'ENTRY_SUPERVISOR', 'ATTENDANT', 'RESCUE');
CREATE TYPE pt_status          AS ENUM ('DRAFT', 'IN_ANALYSIS', 'AWAITING_CORRECTION', 'AWAITING_APPROVAL', 'RELEASED',
                                        'IN_EXECUTION', 'SUSPENDED', 'CLOSED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- ---------------------------------------------------------------------------
-- Trabalhadores e qualificações
-- ---------------------------------------------------------------------------
-- Trabalhador pode não ter login (ex.: terceiro). Para ASSINAR, precisa de user_id
-- com vínculo na empresa.
CREATE TABLE workers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  full_name      text NOT NULL CHECK (length(trim(full_name)) > 0),
  registration   text,
  contractor_id  uuid,
  user_id        uuid,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id, contractor_id) REFERENCES contractors (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE qualification_types (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name           text NOT NULL,
  kind           qualification_kind NOT NULL,
  normative_ref  text,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

-- Registro de qualificação: imutável, só pode ser revogado.
CREATE TABLE worker_qualifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  worker_id       uuid NOT NULL,
  type_id         uuid NOT NULL,
  valid_from      date NOT NULL,
  valid_until     date,
  evidence        text,
  recorded_by     uuid NOT NULL REFERENCES users(id),
  recorded_at     timestamptz(3) NOT NULL DEFAULT now(),
  revoked_at      timestamptz(3),
  revoked_by      uuid REFERENCES users(id),
  revoke_reason   text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, worker_id) REFERENCES workers (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, type_id) REFERENCES qualification_types (tenant_id, id) ON DELETE RESTRICT,
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- ---------------------------------------------------------------------------
-- Tipos de PT (configuração do SST, versionada pela publicação)
-- ---------------------------------------------------------------------------
CREATE TABLE pt_types (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                        uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name                             text NOT NULL,
  version                          int  NOT NULL DEFAULT 1,
  description                      text,
  status                           publish_status NOT NULL DEFAULT 'DRAFT',
  checklist_template_version_id    uuid NOT NULL,
  max_validity_minutes             int  NOT NULL CHECK (max_validity_minutes BETWEEN 15 AND 10080),
  -- Monitoramento atmosférico: [{ key, label, unit, min?, max? }] — limites definidos pelo SST.
  requires_gas_monitoring          boolean NOT NULL DEFAULT false,
  gas_parameters                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  gas_max_age_minutes              int CHECK (gas_max_age_minutes IS NULL OR gas_max_age_minutes BETWEEN 1 AND 1440),
  requires_entry_log               boolean NOT NULL DEFAULT false,
  -- Designação formal exigida de quem libera (ex.: responsável pela autorização da PT).
  releaser_qualification_type_id   uuid,
  segregate_creator_releaser       boolean NOT NULL DEFAULT true,
  author_id                        uuid NOT NULL REFERENCES users(id),
  reviewed_by                      uuid REFERENCES users(id),
  professional_validation          jsonb,
  published_at                     timestamptz(3),
  created_at                       timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name, version),
  FOREIGN KEY (tenant_id, checklist_template_version_id) REFERENCES apr_template_versions (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, releaser_qualification_type_id) REFERENCES qualification_types (tenant_id, id) ON DELETE RESTRICT,
  CHECK (NOT requires_gas_monitoring OR (jsonb_array_length(gas_parameters) > 0 AND gas_max_age_minutes IS NOT NULL)),
  CHECK (status <> 'PUBLISHED' OR (reviewed_by IS NOT NULL AND reviewed_by <> author_id AND professional_validation IS NOT NULL))
);

-- Funções exigidas na equipe e as qualificações de cada uma.
CREATE TABLE pt_type_requirements (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pt_type_id                uuid NOT NULL,
  function                  team_function NOT NULL,
  min_count                 int NOT NULL DEFAULT 1 CHECK (min_count BETWEEN 0 AND 50),
  qualification_type_ids    uuid[] NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, pt_type_id, function),
  FOREIGN KEY (tenant_id, pt_type_id) REFERENCES pt_types (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Permissão de Trabalho
-- ---------------------------------------------------------------------------
CREATE TABLE pt_counters (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  year       int  NOT NULL,
  last       int  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, year)
);

CREATE TABLE work_permits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  number           text NOT NULL,
  pt_type_id       uuid NOT NULL,
  apr_id           uuid NOT NULL,
  unit_id          uuid NOT NULL,
  sector_id        uuid,
  location         text NOT NULL,
  description      text NOT NULL,
  starts_at        timestamptz(3) NOT NULL,
  ends_at          timestamptz(3) NOT NULL,
  status           pt_status NOT NULL DEFAULT 'DRAFT',
  row_version      int NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL REFERENCES users(id),
  submitted_at     timestamptz(3),
  reviewed_by      uuid REFERENCES users(id),
  reviewed_at      timestamptz(3),
  released_by      uuid REFERENCES users(id),
  released_at      timestamptz(3),
  suspended_at     timestamptz(3),
  status_reason    text,
  closed_by        uuid REFERENCES users(id),
  closed_at        timestamptz(3),
  closing_notes    text,
  created_at       timestamptz(3) NOT NULL DEFAULT now(),
  updated_at       timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, pt_type_id) REFERENCES pt_types (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, apr_id) REFERENCES aprs (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, sector_id) REFERENCES sectors (tenant_id, id) ON DELETE RESTRICT,
  CHECK (ends_at > starts_at),
  CHECK (status NOT IN ('RELEASED', 'IN_EXECUTION') OR released_by IS NOT NULL)
);

CREATE TABLE pt_team (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pt_id                      uuid NOT NULL,
  worker_id                  uuid NOT NULL,
  function                   team_function NOT NULL,
  acknowledged_signature_id  uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, pt_id, worker_id, function),
  FOREIGN KEY (tenant_id, pt_id) REFERENCES work_permits (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, worker_id) REFERENCES workers (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE pt_answers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pt_id               uuid NOT NULL,
  question_id         uuid NOT NULL,
  answer              answer_value NOT NULL,
  justification       text,
  corrective_action   text,
  answered_by         uuid NOT NULL REFERENCES users(id),
  answered_at         timestamptz(3) NOT NULL DEFAULT now(),
  reassessed_answer   answer_value,
  reassessed_by       uuid REFERENCES users(id),
  reassessed_at       timestamptz(3),
  version             int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, pt_id, question_id),
  FOREIGN KEY (tenant_id, pt_id) REFERENCES work_permits (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, question_id) REFERENCES apr_template_questions (tenant_id, id) ON DELETE RESTRICT,
  CHECK (reassessed_by IS NULL OR reassessed_by <> answered_by)
);

-- Medições: só inserção. within_limits é calculado pela API com os limites do tipo.
CREATE TABLE pt_measurements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pt_id          uuid NOT NULL,
  parameter_key  text NOT NULL,
  value          numeric NOT NULL,
  unit           text NOT NULL,
  within_limits  boolean NOT NULL,
  instrument     text NOT NULL CHECK (length(trim(instrument)) > 0),
  measured_by    uuid NOT NULL REFERENCES users(id),
  received_at    timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, pt_id) REFERENCES work_permits (tenant_id, id) ON DELETE RESTRICT
);

-- Controle de entradas e saídas (espaço confinado). Uma entrada aberta por pessoa.
CREATE TABLE pt_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pt_id         uuid NOT NULL,
  worker_id     uuid NOT NULL,
  entered_at    timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  entered_by    uuid NOT NULL REFERENCES users(id),
  exited_at     timestamptz(3),
  exited_by     uuid REFERENCES users(id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, pt_id) REFERENCES work_permits (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, worker_id) REFERENCES workers (tenant_id, id) ON DELETE RESTRICT,
  CHECK ((exited_at IS NULL) = (exited_by IS NULL)),
  CHECK (exited_at IS NULL OR exited_at >= entered_at)
);
CREATE UNIQUE INDEX pt_entries_one_open ON pt_entries (tenant_id, pt_id, worker_id) WHERE exited_at IS NULL;

-- Conteúdo exato que foi assinado (JSON canônico) e o hash dele.
CREATE TABLE document_snapshots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_type  text NOT NULL,
  document_id    uuid NOT NULL,
  content        text NOT NULL,
  hash           char(64) NOT NULL,
  created_at     timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  CHECK (hash = encode(sha256(convert_to(content, 'UTF8')), 'hex'))
);

-- Assinatura eletrônica: quem, quando, com que significado, sobre qual conteúdo
-- (hash), e as evidências da autenticação. Imutável.
CREATE TABLE signatures (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_type     text NOT NULL,
  document_id       uuid NOT NULL,
  snapshot_id       uuid NOT NULL,
  document_hash     char(64) NOT NULL,
  meaning           text NOT NULL,
  signer_user_id    uuid NOT NULL REFERENCES users(id),
  signer_name       text NOT NULL,
  signer_context    jsonb NOT NULL,
  evidence          jsonb NOT NULL,
  signed_at         timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES document_snapshots (tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE pt_team ADD FOREIGN KEY (tenant_id, acknowledged_signature_id) REFERENCES signatures (tenant_id, id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Gatilhos
-- ---------------------------------------------------------------------------
CREATE TRIGGER work_permits_touch BEFORE UPDATE ON work_permits FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER pt_types_immutable BEFORE UPDATE OR DELETE ON pt_types FOR EACH ROW EXECUTE FUNCTION published_immutable();

-- Requisitos só mudam com o tipo em rascunho.
CREATE FUNCTION pt_type_requirements_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM pt_types WHERE id = COALESCE(NEW.pt_type_id, OLD.pt_type_id)) IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'requisitos de tipo de PT não rascunho não podem ser alterados' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER pt_type_requirements_guard BEFORE INSERT OR UPDATE OR DELETE ON pt_type_requirements
  FOR EACH ROW EXECUTE FUNCTION pt_type_requirements_guard();

-- Qualificação registrada não muda nem some; só pode ser revogada uma vez.
CREATE FUNCTION worker_qualifications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'qualificação não pode ser apagada; revogue-a' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     OR (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by', 'revoke_reason']) <> (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by', 'revoke_reason']) THEN
    RAISE EXCEPTION 'qualificação registrada não pode ser alterada' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER worker_qualifications_guard BEFORE UPDATE OR DELETE ON worker_qualifications
  FOR EACH ROW EXECUTE FUNCTION worker_qualifications_guard();

-- Máquina de estados da PT, aplicada no próprio banco.
CREATE FUNCTION pt_transition_allowed(f pt_status, t pt_status) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT (f, t) IN (
    ('DRAFT', 'IN_ANALYSIS'), ('DRAFT', 'CANCELLED'),
    ('IN_ANALYSIS', 'AWAITING_APPROVAL'), ('IN_ANALYSIS', 'AWAITING_CORRECTION'), ('IN_ANALYSIS', 'REJECTED'), ('IN_ANALYSIS', 'CANCELLED'),
    ('AWAITING_CORRECTION', 'IN_ANALYSIS'), ('AWAITING_CORRECTION', 'CANCELLED'),
    ('AWAITING_APPROVAL', 'RELEASED'), ('AWAITING_APPROVAL', 'AWAITING_CORRECTION'), ('AWAITING_APPROVAL', 'REJECTED'), ('AWAITING_APPROVAL', 'CANCELLED'),
    ('RELEASED', 'IN_EXECUTION'), ('RELEASED', 'SUSPENDED'), ('RELEASED', 'CANCELLED'), ('RELEASED', 'EXPIRED'),
    ('IN_EXECUTION', 'SUSPENDED'), ('IN_EXECUTION', 'CLOSED'), ('IN_EXECUTION', 'EXPIRED'),
    ('SUSPENDED', 'RELEASED'), ('SUSPENDED', 'CLOSED'), ('SUSPENDED', 'CANCELLED'), ('SUSPENDED', 'EXPIRED'),
    ('EXPIRED', 'CLOSED')
  )
$$;

CREATE FUNCTION work_permits_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PT não pode ser apagada; cancele-a' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT pt_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'transição de % para % não é permitida', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('CLOSED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'PT finalizada não pode ser alterada' USING ERRCODE = 'check_violation';
  END IF;
  -- Dados da PT só mudam em rascunho ou aguardando correção. Depois da
  -- liberação, mudança de condição = suspender e reavaliar, nunca editar.
  IF OLD.status NOT IN ('DRAFT', 'AWAITING_CORRECTION') AND (
       NEW.pt_type_id <> OLD.pt_type_id OR NEW.apr_id <> OLD.apr_id OR NEW.unit_id <> OLD.unit_id
       OR NEW.sector_id IS DISTINCT FROM OLD.sector_id OR NEW.location <> OLD.location OR NEW.description <> OLD.description
       OR NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at) THEN
    RAISE EXCEPTION 'dados da PT não podem ser alterados nesta situação' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.number <> OLD.number OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'identificação da PT não pode ser alterada' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_permits_guard BEFORE UPDATE OR DELETE ON work_permits FOR EACH ROW EXECUTE FUNCTION work_permits_guard();

CREATE FUNCTION pt_status_of(p uuid) RETURNS pt_status LANGUAGE sql STABLE AS $$ SELECT status FROM work_permits WHERE id = p $$;

-- Equipe e checklist: edição só em rascunho/correção. A ciência (assinatura)
-- da equipe é registrada depois da liberação e pode ser zerada na retomada.
CREATE FUNCTION pt_team_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st pt_status := pt_status_of(COALESCE(NEW.pt_id, OLD.pt_id));
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'acknowledged_signature_id') = (to_jsonb(OLD) - 'acknowledged_signature_id') THEN
    IF st NOT IN ('RELEASED', 'SUSPENDED', 'AWAITING_APPROVAL') THEN
      RAISE EXCEPTION 'ciência só é registrada com a PT liberada' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF st NOT IN ('DRAFT', 'AWAITING_CORRECTION') THEN
    RAISE EXCEPTION 'a equipe da PT não pode ser alterada nesta situação' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER pt_team_guard BEFORE INSERT OR UPDATE OR DELETE ON pt_team FOR EACH ROW EXECUTE FUNCTION pt_team_guard();

CREATE FUNCTION pt_answers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pt_status_of(COALESCE(NEW.pt_id, OLD.pt_id)) NOT IN ('DRAFT', 'AWAITING_CORRECTION', 'IN_ANALYSIS') THEN
    RAISE EXCEPTION 'o checklist da PT não pode ser alterado nesta situação' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER pt_answers_guard BEFORE INSERT OR UPDATE OR DELETE ON pt_answers FOR EACH ROW EXECUTE FUNCTION pt_answers_guard();

CREATE FUNCTION pt_measurements_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'medições não podem ser alteradas nem apagadas' USING ERRCODE = 'check_violation';
  END IF;
  IF pt_status_of(NEW.pt_id) NOT IN ('AWAITING_APPROVAL', 'RELEASED', 'IN_EXECUTION', 'SUSPENDED') THEN
    RAISE EXCEPTION 'medição não permitida nesta situação da PT' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pt_measurements_guard BEFORE INSERT OR UPDATE OR DELETE ON pt_measurements FOR EACH ROW EXECUTE FUNCTION pt_measurements_guard();

-- Entrada só com PT em execução e dentro da validade. SAÍDA sempre pode ser
-- registrada, em qualquer situação: nunca impedir o registro de quem sai.
CREATE FUNCTION pt_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pt work_permits%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'registro de entrada não pode ser apagado' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.exited_at IS NOT NULL OR (to_jsonb(NEW) - ARRAY['exited_at', 'exited_by']) <> (to_jsonb(OLD) - ARRAY['exited_at', 'exited_by']) THEN
      RAISE EXCEPTION 'registro de entrada só aceita o registro da saída, uma vez' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO pt FROM work_permits WHERE id = NEW.pt_id;
  IF pt.status <> 'IN_EXECUTION' OR pt.ends_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'entrada não autorizada: a PT não está em execução válida' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pt_team WHERE pt_id = NEW.pt_id AND worker_id = NEW.worker_id AND acknowledged_signature_id IS NOT NULL) THEN
    RAISE EXCEPTION 'entrada não autorizada: pessoa fora da equipe ou sem ciência registrada' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pt_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON pt_entries FOR EACH ROW EXECUTE FUNCTION pt_entries_guard();

CREATE FUNCTION immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% é somente inserção', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE TRIGGER signatures_immutable BEFORE UPDATE OR DELETE ON signatures FOR EACH ROW EXECUTE FUNCTION immutable_row();
CREATE TRIGGER snapshots_immutable BEFORE UPDATE OR DELETE ON document_snapshots FOR EACH ROW EXECUTE FUNCTION immutable_row();

CREATE FUNCTION next_pt_number(p_year int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  INSERT INTO pt_counters (tenant_id, year, last) VALUES (app_tenant_id(), p_year, 1)
  ON CONFLICT (tenant_id, year) DO UPDATE SET last = pt_counters.last + 1
  RETURNING last INTO n;
  RETURN format('PT-%s-%s', p_year, lpad(n::text, 6, '0'));
END $$;

-- Marca como expiradas as PTs da empresa ativa cujo prazo acabou. A API também
-- confere o prazo em cada leitura, para não depender desta rotina rodar.
CREATE FUNCTION expire_work_permits() RETURNS SETOF uuid LANGUAGE sql AS $$
  UPDATE work_permits SET status = 'EXPIRED', status_reason = 'Prazo de validade encerrado', row_version = row_version + 1
   WHERE tenant_id = app_tenant_id() AND status IN ('RELEASED', 'IN_EXECUTION', 'SUSPENDED') AND ends_at <= clock_timestamp()
  RETURNING id
$$;

-- ---------------------------------------------------------------------------
-- RLS e permissões
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workers', 'qualification_types', 'worker_qualifications', 'pt_types', 'pt_type_requirements',
                           'pt_counters', 'work_permits', 'pt_team', 'pt_answers', 'pt_measurements', 'pt_entries',
                           'document_snapshots', 'signatures'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_tenant', t);
  END LOOP;
END $$;

GRANT USAGE ON TYPE qualification_kind, team_function, pt_status TO sitedopai_app;
GRANT SELECT, INSERT, UPDATE ON workers, qualification_types, worker_qualifications, pt_types, work_permits, pt_team,
  pt_answers, pt_entries, pt_counters TO sitedopai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON pt_type_requirements TO sitedopai_app;
GRANT DELETE ON pt_team, pt_answers TO sitedopai_app;
GRANT SELECT, INSERT ON pt_measurements, document_snapshots, signatures TO sitedopai_app;
GRANT EXECUTE ON FUNCTION next_pt_number(int), expire_work_permits(), pt_transition_allowed(pt_status, pt_status), pt_status_of(uuid) TO sitedopai_app;
