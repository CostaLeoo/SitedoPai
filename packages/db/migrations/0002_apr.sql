-- 0002_apr — Fase 2a: matriz de risco, modelos de APR versionados, APR,
-- respostas de checklist, análise de riscos, biblioteca de perigos e fotos.
-- Mesmas regras da 0001: tenant_id + chaves compostas + RLS com FORCE.

CREATE TYPE publish_status     AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'RETIRED');
CREATE TYPE answer_value       AS ENUM ('YES', 'NO', 'NA');
CREATE TYPE criticality        AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE mismatch_effect    AS ENUM ('ALERT', 'PENDING', 'BLOCK');
CREATE TYPE apr_status         AS ENUM ('DRAFT', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'CANCELLED');
CREATE TYPE control_type       AS ENUM ('ELIMINATION', 'SUBSTITUTION', 'ENGINEERING', 'ADMINISTRATIVE', 'PPE');
CREATE TYPE scan_status        AS ENUM ('PENDING', 'CLEAN', 'REJECTED');

-- ---------------------------------------------------------------------------
-- Matriz de risco (metodologia configurável por empresa, versionada)
-- ---------------------------------------------------------------------------
CREATE TABLE risk_matrices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name                text NOT NULL,
  version             int  NOT NULL DEFAULT 1,
  status              publish_status NOT NULL DEFAULT 'DRAFT',
  -- [{ "value": 1, "label": "Raro" }, ...]
  probability_levels  jsonb NOT NULL,
  severity_levels     jsonb NOT NULL,
  -- [{ "min": 1, "max": 4, "label": "Baixo", "acceptable": true }, ...] sobre probabilidade × severidade
  classes             jsonb NOT NULL,
  created_by          uuid NOT NULL REFERENCES users(id),
  published_by        uuid REFERENCES users(id),
  published_at        timestamptz(3),
  created_at          timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name, version)
);

-- ---------------------------------------------------------------------------
-- Modelos de APR: o modelo agrupa versões; cada versão tem as perguntas.
-- Versão publicada é imutável; mudanças exigem nova versão.
-- ---------------------------------------------------------------------------
CREATE TABLE apr_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name          text NOT NULL,
  service_type  text NOT NULL,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE apr_template_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  template_id    uuid NOT NULL,
  version        int  NOT NULL,
  status         publish_status NOT NULL DEFAULT 'DRAFT',
  author_id      uuid NOT NULL REFERENCES users(id),
  submitted_at   timestamptz(3),
  reviewed_by    uuid REFERENCES users(id),
  reviewed_at    timestamptz(3),
  review_note    text,
  -- Identificação do profissional que validou tecnicamente (nome, registro, data).
  professional_validation jsonb,
  published_at   timestamptz(3),
  created_at     timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, template_id, version),
  FOREIGN KEY (tenant_id, template_id) REFERENCES apr_templates (tenant_id, id) ON DELETE RESTRICT,
  CHECK (status <> 'PUBLISHED' OR (reviewed_by IS NOT NULL AND reviewed_by <> author_id AND professional_validation IS NOT NULL))
);

CREATE TABLE apr_template_questions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  template_version_id   uuid NOT NULL,
  position              int  NOT NULL CHECK (position > 0),
  text                  text NOT NULL CHECK (length(trim(text)) > 0),
  help_text             text,
  expected_answer       answer_value NOT NULL,
  criticality           criticality NOT NULL DEFAULT 'MEDIUM',
  required              boolean NOT NULL DEFAULT true,
  allow_na              boolean NOT NULL DEFAULT false,
  -- Respostas que exigem justificativa. 'MISMATCH' = qualquer resposta diferente da esperada.
  justification_on      text[] NOT NULL DEFAULT '{MISMATCH}',
  photos_required       int  NOT NULL DEFAULT 0 CHECK (photos_required BETWEEN 0 AND 5),
  photos_max            int  NOT NULL DEFAULT 0 CHECK (photos_max BETWEEN 0 AND 5),
  mismatch_effect       mismatch_effect NOT NULL DEFAULT 'PENDING',
  normative_ref         text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, template_version_id, position),
  FOREIGN KEY (tenant_id, template_version_id) REFERENCES apr_template_versions (tenant_id, id) ON DELETE CASCADE,
  CHECK (photos_required <= photos_max),
  CHECK (justification_on <@ ARRAY['YES', 'NO', 'NA', 'MISMATCH']),
  CHECK (expected_answer <> 'NA' OR allow_na),
  CHECK (criticality <> 'CRITICAL' OR mismatch_effect = 'BLOCK')
);

-- Biblioteca de perigos e controles: apoio, não substitui a análise da atividade.
CREATE TABLE hazard_library (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  hazard              text NOT NULL,
  consequence         text NOT NULL,
  suggested_controls  jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags                text[] NOT NULL DEFAULT '{}',
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- APR
-- ---------------------------------------------------------------------------
CREATE TABLE apr_counters (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  year       int  NOT NULL,
  last       int  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, year)
);

CREATE TABLE aprs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  number                 text NOT NULL,
  revision               int  NOT NULL DEFAULT 0,
  previous_revision_id   uuid,
  template_version_id    uuid NOT NULL,
  risk_matrix_id         uuid NOT NULL,
  unit_id                uuid NOT NULL,
  sector_id              uuid,
  location               text NOT NULL DEFAULT '',
  activity_date          date NOT NULL,
  service_description    text NOT NULL DEFAULT '',
  responsible_name       text NOT NULL DEFAULT '',
  team                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  equipment              jsonb NOT NULL DEFAULT '[]'::jsonb,
  contractor_ids         uuid[] NOT NULL DEFAULT '{}',
  status                 apr_status NOT NULL DEFAULT 'DRAFT',
  row_version            int  NOT NULL DEFAULT 1,
  analysis_version       int  NOT NULL DEFAULT 1,
  created_by             uuid NOT NULL REFERENCES users(id),
  submitted_by           uuid REFERENCES users(id),
  submitted_at           timestamptz(3),
  decided_by             uuid REFERENCES users(id),
  decided_at             timestamptz(3),
  decision_note          text,
  created_at             timestamptz(3) NOT NULL DEFAULT now(),
  updated_at             timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number, revision),
  FOREIGN KEY (tenant_id, template_version_id) REFERENCES apr_template_versions (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, risk_matrix_id) REFERENCES risk_matrices (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, sector_id) REFERENCES sectors (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, previous_revision_id) REFERENCES aprs (tenant_id, id) ON DELETE RESTRICT,
  CHECK (status <> 'APPROVED' OR (decided_by IS NOT NULL AND decided_by <> created_by))
);

CREATE TABLE apr_answers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  apr_id              uuid NOT NULL,
  question_id         uuid NOT NULL,
  answer              answer_value NOT NULL,
  justification       text,
  corrective_action   text,
  answered_by         uuid NOT NULL REFERENCES users(id),
  answered_at         timestamptz(3) NOT NULL DEFAULT now(),
  -- Nova avaliação depois da ação corretiva (perguntas com efeito BLOCK).
  reassessed_answer   answer_value,
  reassessed_by       uuid REFERENCES users(id),
  reassessed_at       timestamptz(3),
  version             int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, apr_id, question_id),
  FOREIGN KEY (tenant_id, apr_id) REFERENCES aprs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, question_id) REFERENCES apr_template_questions (tenant_id, id) ON DELETE RESTRICT,
  CHECK (reassessed_by IS NULL OR reassessed_by <> answered_by)
);

-- Análise: etapas → perigos → controles. Probabilidade e severidade referem-se
-- aos níveis da matriz vinculada à APR; score = probabilidade × severidade.
CREATE TABLE apr_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  apr_id       uuid NOT NULL,
  position     int  NOT NULL,
  description  text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, apr_id, position),
  FOREIGN KEY (tenant_id, apr_id) REFERENCES aprs (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE apr_hazards (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  step_id                uuid NOT NULL,
  position               int  NOT NULL,
  hazard                 text NOT NULL,
  consequence            text NOT NULL,
  probability            int,
  severity               int,
  residual_probability   int,
  residual_severity      int,
  library_id             uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, step_id, position),
  FOREIGN KEY (tenant_id, step_id) REFERENCES apr_steps (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, library_id) REFERENCES hazard_library (tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE apr_controls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  hazard_id         uuid NOT NULL,
  position          int  NOT NULL,
  description       text NOT NULL,
  control_type      control_type NOT NULL,
  responsible_name  text NOT NULL DEFAULT '',
  verified          boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, hazard_id, position),
  FOREIGN KEY (tenant_id, hazard_id) REFERENCES apr_hazards (tenant_id, id) ON DELETE CASCADE
);

-- Fotos: o original é preservado (com hash), e uma cópia de exibição sem
-- metadados é gerada no recebimento. Remoção só antes do envio para revisão.
CREATE TABLE apr_photos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  apr_id             uuid NOT NULL,
  question_id        uuid NOT NULL,
  apr_revision       int  NOT NULL,
  original_key       text NOT NULL,
  display_key        text NOT NULL,
  mime_type          text NOT NULL,
  size_bytes         int  NOT NULL CHECK (size_bytes > 0),
  sha256             char(64) NOT NULL,
  width              int,
  height             int,
  scan_status        scan_status NOT NULL DEFAULT 'PENDING',
  uploaded_by        uuid NOT NULL REFERENCES users(id),
  received_at        timestamptz(3) NOT NULL DEFAULT now(),
  removed_at         timestamptz(3),
  removed_by         uuid REFERENCES users(id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, apr_id) REFERENCES aprs (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, question_id) REFERENCES apr_template_questions (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX apr_photos_active ON apr_photos (tenant_id, apr_id, question_id) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Gatilhos de integridade
-- ---------------------------------------------------------------------------
CREATE TRIGGER aprs_touch BEFORE UPDATE ON aprs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Matriz e versão de modelo publicadas não mudam (exceto aposentar a versão).
CREATE FUNCTION published_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'registro publicado não pode ser removido' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'RETIRED' AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'registro publicado não pode ser alterado; crie uma nova versão' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'RETIRED' THEN
    RAISE EXCEPTION 'registro aposentado não pode ser alterado' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER risk_matrices_immutable BEFORE UPDATE OR DELETE ON risk_matrices
  FOR EACH ROW EXECUTE FUNCTION published_immutable();
CREATE TRIGGER template_versions_immutable BEFORE UPDATE OR DELETE ON apr_template_versions
  FOR EACH ROW EXECUTE FUNCTION published_immutable();

-- Perguntas só mudam enquanto a versão do modelo está em rascunho.
CREATE FUNCTION template_questions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st publish_status;
BEGIN
  SELECT status INTO st FROM apr_template_versions
   WHERE id = COALESCE(NEW.template_version_id, OLD.template_version_id);
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'perguntas de versão não rascunho não podem ser alteradas' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER template_questions_guard BEFORE INSERT OR UPDATE OR DELETE ON apr_template_questions
  FOR EACH ROW EXECUTE FUNCTION template_questions_guard();

-- Só se cria APR a partir de versão publicada e matriz publicada.
CREATE FUNCTION aprs_require_published() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM apr_template_versions WHERE id = NEW.template_version_id AND status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'o modelo precisa estar publicado' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM risk_matrices WHERE id = NEW.risk_matrix_id AND status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'a matriz de risco precisa estar publicada' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aprs_require_published BEFORE INSERT ON aprs
  FOR EACH ROW EXECUTE FUNCTION aprs_require_published();

-- APR aprovada ou cancelada não muda. Em revisão, só a decisão é permitida.
CREATE FUNCTION aprs_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APR não pode ser apagada; cancele-a' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('APPROVED', 'CANCELLED') THEN
    RAISE EXCEPTION 'APR finalizada não pode ser alterada; crie uma revisão' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'IN_REVIEW' AND NEW.status = 'IN_REVIEW' THEN
    RAISE EXCEPTION 'APR em revisão não pode ser editada' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.template_version_id <> OLD.template_version_id OR NEW.risk_matrix_id <> OLD.risk_matrix_id
     OR NEW.number <> OLD.number OR NEW.revision <> OLD.revision OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'campos de identificação da APR não podem ser alterados' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aprs_lock BEFORE UPDATE OR DELETE ON aprs FOR EACH ROW EXECUTE FUNCTION aprs_lock();

-- Respostas, análise e fotos só mudam com a APR em rascunho ou devolvida.
CREATE FUNCTION apr_child_editable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  st apr_status;
BEGIN
  IF TG_TABLE_NAME = 'apr_hazards' THEN
    SELECT s.apr_id INTO target FROM apr_steps s WHERE s.id = COALESCE(NEW.step_id, OLD.step_id);
  ELSIF TG_TABLE_NAME = 'apr_controls' THEN
    SELECT s.apr_id INTO target FROM apr_hazards h JOIN apr_steps s ON s.id = h.step_id
     WHERE h.id = COALESCE(NEW.hazard_id, OLD.hazard_id);
  ELSE
    target := COALESCE(NEW.apr_id, OLD.apr_id);
  END IF;
  SELECT status INTO st FROM aprs WHERE id = target;
  -- Exclusão em cascata ao apagar a APR é barrada pelo próprio aprs_lock.
  IF st NOT IN ('DRAFT', 'RETURNED') THEN
    RAISE EXCEPTION 'a APR não está em edição' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER apr_answers_editable  BEFORE INSERT OR UPDATE OR DELETE ON apr_answers  FOR EACH ROW EXECUTE FUNCTION apr_child_editable();
CREATE TRIGGER apr_steps_editable    BEFORE INSERT OR UPDATE OR DELETE ON apr_steps    FOR EACH ROW EXECUTE FUNCTION apr_child_editable();
CREATE TRIGGER apr_hazards_editable  BEFORE INSERT OR UPDATE OR DELETE ON apr_hazards  FOR EACH ROW EXECUTE FUNCTION apr_child_editable();
CREATE TRIGGER apr_controls_editable BEFORE INSERT OR UPDATE OR DELETE ON apr_controls FOR EACH ROW EXECUTE FUNCTION apr_child_editable();
CREATE TRIGGER apr_photos_editable   BEFORE INSERT OR UPDATE OR DELETE ON apr_photos   FOR EACH ROW EXECUTE FUNCTION apr_child_editable();

-- Fotos: nunca apagadas (só marcadas como removidas), dados do arquivo imutáveis,
-- e no máximo photos_max ativas por pergunta (com lock contra corrida).
CREATE FUNCTION apr_photos_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  maxp int;
  n int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fotos não são apagadas; use a remoção lógica' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['removed_at', 'removed_by', 'scan_status']) <> (to_jsonb(OLD) - ARRAY['removed_at', 'removed_by', 'scan_status']) THEN
      RAISE EXCEPTION 'dados da foto não podem ser alterados' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.removed_at IS NOT NULL AND NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
      RAISE EXCEPTION 'foto removida não pode ser restaurada' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('photos:' || NEW.apr_id::text || NEW.question_id::text, 0));
  SELECT q.photos_max INTO maxp FROM apr_template_questions q WHERE q.id = NEW.question_id;
  SELECT count(*) INTO n FROM apr_photos
   WHERE apr_id = NEW.apr_id AND question_id = NEW.question_id AND removed_at IS NULL;
  IF n >= COALESCE(maxp, 0) THEN
    RAISE EXCEPTION 'limite de fotos da pergunta atingido' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER apr_photos_guard BEFORE INSERT OR UPDATE OR DELETE ON apr_photos
  FOR EACH ROW EXECUTE FUNCTION apr_photos_guard();

-- Número sequencial por empresa e ano: APR-2026-000001.
CREATE FUNCTION next_apr_number(p_year int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  INSERT INTO apr_counters (tenant_id, year, last) VALUES (app_tenant_id(), p_year, 1)
  ON CONFLICT (tenant_id, year) DO UPDATE SET last = apr_counters.last + 1
  RETURNING last INTO n;
  RETURN format('APR-%s-%s', p_year, lpad(n::text, 6, '0'));
END $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['risk_matrices', 'apr_templates', 'apr_template_versions', 'apr_template_questions',
                           'hazard_library', 'apr_counters', 'aprs', 'apr_answers', 'apr_steps', 'apr_hazards',
                           'apr_controls', 'apr_photos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_tenant', t);
  END LOOP;
END $$;

GRANT USAGE ON TYPE publish_status, answer_value, criticality, mismatch_effect, apr_status, control_type, scan_status TO sitedopai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON risk_matrices, apr_templates, apr_template_versions, apr_template_questions,
  hazard_library, apr_answers, apr_steps, apr_hazards, apr_controls TO sitedopai_app;
GRANT SELECT, INSERT, UPDATE ON aprs, apr_photos, apr_counters TO sitedopai_app;
GRANT EXECUTE ON FUNCTION next_apr_number(int) TO sitedopai_app;
