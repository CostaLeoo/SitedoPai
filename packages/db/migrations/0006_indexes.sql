-- Fase 6 (carga): índices das listagens e consultas mais frequentes.
CREATE INDEX aprs_list ON aprs (tenant_id, updated_at DESC, id);
CREATE INDEX work_permits_list ON work_permits (tenant_id, starts_at DESC, id);
CREATE INDEX pt_measurements_pt ON pt_measurements (tenant_id, pt_id, received_at);
CREATE INDEX pt_entries_pt ON pt_entries (tenant_id, pt_id);
CREATE INDEX signatures_doc ON signatures (tenant_id, document_type, document_id);
CREATE INDEX audit_events_entity ON audit_events (tenant_id, entity_type, entity_id);
