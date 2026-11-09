# PROJETO: PLATAFORMA SaaS DE APR E PERMISSÃO DE TRABALHO DIGITAL

## 1. OBJETIVO

Você é um engenheiro de software sênior, arquiteto de sistemas SaaS, especialista em cibersegurança, UI/UX e desenvolvimento de aplicações web empresariais.

Quero que você desenvolva uma plataforma web comercial de gestão de Análise Preliminar de Riscos (APR) e Permissão de Trabalho (PT), destinada a empresas brasileiras.

A plataforma será vendida mediante assinatura mensal. Cada empresa contratante terá seu ambiente, seus usuários, suas APRs, suas PTs, seus documentos e suas configurações.

O produto deverá substituir, quando juridicamente admissível e mediante os controles necessários, os processos de APR e PT realizados em papel.

Não quero somente um protótipo visual. Quero um projeto funcional, seguro, escalável, testável e preparado para comercialização.

**Princípio fundamental:** a segurança dos trabalhadores tem prioridade sobre a velocidade de preenchimento e liberação.

## 2. PESQUISA NORMATIVA OBRIGATÓRIA

Antes de implementar os formulários, consulte as versões oficiais vigentes das Normas Regulamentadoras brasileiras, disponibilizadas pelo Ministério do Trabalho e Emprego.

Analise, no mínimo:

- NR-01: disposições gerais e gerenciamento de riscos ocupacionais.
- NR-06: equipamentos de proteção individual.
- NR-10: segurança em instalações e serviços em eletricidade.
- NR-12: segurança em máquinas e equipamentos.
- NR-18: segurança e saúde na indústria da construção.
- NR-20: inflamáveis e combustíveis, quando aplicável.
- NR-33: segurança e saúde em espaços confinados.
- NR-35: trabalho em altura.
- Outras normas aplicáveis conforme a atividade e o setor.

Considere também LGPD, legislação sobre documentos eletrônicos, assinaturas eletrônicas, evidências digitais e requisitos de guarda documental.

**Não invente exigências legais, perguntas supostamente obrigatórias, prazos de retenção ou critérios de aprovação.**

Produza uma matriz de conformidade contendo:

1. Norma e dispositivo aplicável.
2. Requisito identificado.
3. Funcionalidade do sistema que atende ao requisito.
4. Evidência documental produzida.
5. Prazo de guarda aplicável, com fundamento.
6. Pontos que exigem validação por profissional de SST ou jurídico.

Separe requisitos expressamente obrigatórios de boas práticas e configurações adicionais.

Os modelos normativos devem ser versionados e revisados por profissionais qualificados antes de serem disponibilizados como modelos aprovados.

## 3. REFERÊNCIA DE MERCADO

Utilize como referência funcional o CESLA Horus, especialmente:

- Gestão digital de APR e PT.
- Fluxos de autorização.
- Assinaturas eletrônicas.
- Evidências fotográficas.
- Controle de trabalhadores habilitados ou autorizados.
- Documentos em PDF.
- Gestão e consulta de permissões.
- Utilização em dispositivos móveis.

Pesquise exclusivamente informações públicas e implemente uma solução original.

Não copie código, identidade visual, conteúdo protegido ou elementos proprietários.

## 4. ARQUITETURA TÉCNICA

Sugestão inicial de tecnologias:

Frontend:
- Next.js com TypeScript.
- React.
- Tailwind CSS.
- Componentes acessíveis, como shadcn/ui.
- React Hook Form e Zod.

Backend:
- API em TypeScript, utilizando NestJS ou arquitetura equivalente.
- PostgreSQL.
- Prisma ORM.
- Redis para filas, quando necessário.
- Armazenamento privado de documentos em serviço compatível com S3.

Infraestrutura:
- Docker.
- Ambientes separados de desenvolvimento, homologação e produção.
- Migrações versionadas.
- CI/CD.
- Monitoramento e alertas.
- Backups automatizados e testados.
- HTTPS obrigatório.

A arquitetura deve ser modular, com responsabilidades separadas e possibilidade de expansão.

Justifique decisões tecnológicas relevantes antes da implementação.

## 5. SISTEMA MULTIEMPRESA (MULTI-TENANT)

A plataforma terá múltiplas empresas clientes.

Cada empresa deverá possuir:

- Cadastro com razão social, nome fantasia e CNPJ.
- Unidades operacionais.
- Setores e áreas.
- Colaboradores.
- Prestadores de serviço.
- Usuários e permissões.
- Modelos de APR e PT.
- Documentos emitidos.
- Histórico de atividades.
- Configurações específicas.

**Regra inegociável:** uma empresa jamais poderá visualizar, modificar ou baixar dados de outra empresa sem autorização explícita e controlada.

Implemente isolamento no banco de dados, nas APIs, nos arquivos e nas consultas, com testes automatizados contra vazamento entre empresas.

## 6. PERFIS DE USUÁRIO

Crie um sistema de permissões baseado em papéis e escopos.

Perfis iniciais:

**Administrador da plataforma**
- Gerencia empresas clientes.
- Gerencia planos e assinaturas.
- Visualiza indicadores comerciais.
- Gerencia suporte e configurações globais.
- Não possui acesso irrestrito ao conteúdo confidencial dos clientes.

**Administrador da empresa**
- Cadastra usuários.
- Configura unidades.
- Gerencia permissões.
- Consulta documentos da própria empresa.
- Configura fluxos de aprovação.

**Profissional de SST**
- Revisa análises de risco.
- Administra modelos de formulários.
- Verifica requisitos de segurança.
- Aprova etapas conforme sua competência e autorização.

**Supervisor ou responsável pela liberação**
- Analisa solicitações.
- Verifica condições de segurança.
- Autoriza ou rejeita atividades dentro de suas atribuições.

**Executante**
- Preenche informações autorizadas.
- Consulta documentos pertinentes.
- Anexa evidências.
- Assina registros e confirma ciência dos riscos.

**Auditor**
- Acessa documentos e históricos conforme permissões específicas.
- Não altera registros finalizados.

As permissões não devem ser determinadas apenas pelo nome do perfil. Devem considerar treinamento, competência, designação formal, unidade e atividade.

## 7. DESIGN E EXPERIÊNCIA DO USUÁRIO

Quero uma interface moderna, profissional, intuitiva e extremamente fácil de utilizar.

A maior parte dos trabalhadores poderá utilizar o sistema diretamente no celular, inclusive em ambientes industriais.

Requisitos:

- Mobile-first.
- Design responsivo.
- Navegação simples.
- Botões grandes para uso em campo.
- Boa legibilidade.
- Alto contraste.
- Acessibilidade seguindo WCAG 2.2 AA como meta.
- Feedback claro de erros.
- Salvamento automático de rascunhos.
- Indicador de progresso.
- Carregamento rápido.
- Poucas etapas desnecessárias.

### REGRA VISUAL OBRIGATÓRIA DOS FORMULÁRIOS

Todas as perguntas devem aparecer verticalmente.

**Uma pergunta abaixo da outra. Nunca colocar duas perguntas lado a lado.**

Cada pergunta de checklist terá três opções:

- Sim
- Não
- N/A (Não se aplica)

As opções serão apresentadas como botões de seleção única, com áreas de toque confortáveis.

Exemplo:

**1. Os equipamentos de proteção individual exigidos foram verificados?**

( ) Sim

( ) Não

( ) N/A

**2. A área de trabalho está devidamente sinalizada e isolada?**

( ) Sim

( ) Não

( ) N/A

**3. Os trabalhadores possuem as autorizações necessárias?**

( ) Sim

( ) Não

( ) N/A

Não interpretar automaticamente "Sim" como resposta segura em todas as perguntas.

Cada pergunta deverá possuir metadados que definam:

- Resposta esperada.
- Criticidade.
- Obrigatoriedade.
- Possibilidade de N/A.
- Necessidade de justificativa.
- Necessidade de fotografia.
- Consequência de resposta incompatível.
- Referência normativa, quando aplicável.

Perguntas críticas poderão bloquear o avanço e exigir ação corretiva e nova avaliação.

## 8. ANEXOS FOTOGRÁFICOS

Cada pergunta configurada para receber fotografias terá um botão:

**Adicionar fotos**

Requisitos:

- Máximo de 5 fotos por pergunta.
- Captura diretamente pela câmera.
- Seleção pela galeria.
- Pré-visualização.
- Exclusão antes do envio definitivo.
- Compressão com preservação da qualidade necessária para evidência.
- Validação de formato e tamanho.
- Proteção contra arquivos maliciosos.
- Armazenamento privado.
- Associação das fotos à pergunta, documento e versão correspondente.

Preservar os arquivos originais quando necessário para integridade probatória.

Registrar metadados confiáveis, hash e horário do recebimento.

Não exigir localização GPS por padrão.

As fotografias devem integrar o relatório final quando aplicável.

## 9. CRIAÇÃO DA APR

Criar um módulo completo para Análise Preliminar de Riscos.

Dados iniciais:

- Número identificador.
- Empresa.
- Unidade.
- Setor.
- Local da atividade.
- Data.
- Descrição do serviço.
- Responsável.
- Equipe executante.
- Equipamentos utilizados.
- Empresas terceirizadas envolvidas.

A APR deverá permitir a descrição estruturada de:

1. Etapas da atividade.
2. Perigos identificados.
3. Possíveis consequências.
4. Avaliação de riscos.
5. Medidas de prevenção e controle.
6. Responsáveis pela implementação.
7. Verificação das medidas.
8. Risco residual, conforme metodologia aprovada.
9. Evidências.
10. Responsáveis pela análise e aprovação.

Disponibilize biblioteca de perigos e controles, sem substituir a análise específica da atividade.

O sistema deverá permitir modelos por tipo de serviço, como:

- Trabalho em altura.
- Espaço confinado.
- Serviços elétricos.
- Trabalho a quente.
- Manutenção de máquinas.
- Serviços em telhados.
- Atividades com produtos químicos.
- Içamento de cargas.
- Obras e manutenção industrial.

Cada modelo deve ser configurável e validado antes de seu uso operacional.

## 10. EMISSÃO DA PERMISSÃO DE TRABALHO

A PT será vinculada à APR correspondente.

Dados da PT:

- Identificador único.
- Empresa e unidade.
- Área e local.
- Descrição da atividade.
- Data e horário.
- Prazo de validade.
- Responsáveis.
- Equipe autorizada.
- APR vinculada.
- Medidas de segurança.
- Checklist aplicável.
- Evidências fotográficas.
- Aprovações.
- Assinaturas.
- Histórico de alterações.
- Encerramento.

O sistema deve verificar os requisitos aplicáveis antes da liberação.

Fluxo sugerido:

Rascunho → Em análise → Aguardando correção → Aguardando aprovação → Liberada → Em execução → Encerrada.

Também deverão existir estados como:

- Rejeitada.
- Suspensa.
- Cancelada.
- Expirada.

Uma PT suspensa, expirada ou cancelada não poderá ser apresentada como autorização válida.

Mudanças relevantes nas condições de trabalho deverão provocar reavaliação e, quando exigido, nova autorização.

Implemente regras específicas para permissões de entrada e trabalho em espaços confinados e outros casos com requisitos próprios.

Nunca liberar automaticamente atividades críticas somente com base em respostas de formulário.

## 11. ASSINATURAS ELETRÔNICAS

Implementar mecanismo de assinatura eletrônica compatível com os requisitos legais aplicáveis ao documento e ao contexto.

Requisitos:

- Identificação do signatário.
- Autenticação adequada.
- Vinculação da assinatura à versão exata do documento.
- Registro de data e hora.
- Evidências de autenticação.
- Integridade do conteúdo.
- Detecção de alterações posteriores.
- Histórico de assinaturas.
- Verificação de autenticidade.

Permitir assinatura desenhada na tela apenas como recurso de interface, sem tratá-la isoladamente como prova suficiente de autoria.

Avaliar quando são necessárias assinaturas avançadas, qualificadas ou outros mecanismos.

Documentos finalizados não poderão ser modificados silenciosamente.

## 12. GERAÇÃO DE DOCUMENTOS PDF

Toda APR e PT deverá poder ser exportada em PDF.

O documento deverá conter:

- Identificação da empresa.
- Identificador único.
- Dados da atividade.
- Perguntas e respostas.
- Análise de riscos.
- Medidas de controle.
- Justificativas.
- Evidências fotográficas.
- Responsáveis.
- Assinaturas.
- Datas e horários.
- Situação do documento.
- Histórico relevante.
- Identificação da versão.
- QR Code para verificação de autenticidade.

O QR Code não poderá expor dados pessoais ou documentos confidenciais sem autenticação e autorização.

## 13. ARQUIVAMENTO E RETENÇÃO

O sistema deverá preservar os documentos pelo período legal e contratual aplicável.

Não adotar prazo universal de retenção.

Criar uma matriz configurável por:

- Tipo de documento.
- Norma aplicável.
- Data do evento.
- Prazo mínimo.
- Requisitos contratuais.
- Necessidade de preservação por litígio ou investigação.

O prazo efetivo não poderá ser inferior ao legalmente obrigatório.

Criar:

- Armazenamento durável.
- Controle de integridade.
- Backups.
- Testes periódicos de restauração.
- Histórico de acesso.
- Proteção contra exclusão indevida.
- Exportação em formatos acessíveis.
- Política de descarte seguro.
- Retenção especial para documentos sob investigação.

**O cancelamento da assinatura comercial não poderá causar exclusão automática de documentos que devam ser preservados.**

Definir regras transparentes de acesso, exportação, custódia e eventual migração dos documentos após encerramento contratual.

## 14. SEGURANÇA E LGPD

Implementar segurança desde a concepção do sistema.

Requisitos:

- Autenticação segura.
- MFA para perfis privilegiados.
- Controle de sessão.
- RBAC e autorização por recurso.
- Isolamento entre empresas.
- TLS.
- Criptografia em repouso.
- Gestão segura de segredos.
- Proteção contra SQL Injection, XSS e CSRF.
- Rate limiting.
- Validação de entradas.
- Logs de segurança.
- Trilhas de auditoria resistentes à adulteração.
- Backups criptografados.
- Recuperação de desastres.
- Testes de vulnerabilidade.
- Proteção de anexos.
- Monitoramento de incidentes.
- Política de resposta a incidentes.

Não armazenar senhas em texto puro.

Não expor credenciais no frontend.

Aplicar minimização de dados pessoais, controles de acesso e retenção adequada.

Documentar os papéis de controlador e operador de dados, conforme cada operação.

## 15. PAINEL DA EMPRESA CLIENTE

Após login, apresentar dashboard com:

- PTs abertas.
- PTs aguardando aprovação.
- PTs liberadas.
- PTs em execução.
- PTs suspensas.
- PTs encerradas.
- Documentos próximos do vencimento.
- Pendências de segurança.
- Atividades por unidade.
- Indicadores por período.

Criar filtros por:

- Data.
- Empresa ou unidade.
- Setor.
- Responsável.
- Tipo de atividade.
- Status.

Permitir exportação de relatórios conforme as permissões do usuário.

## 16. PAINEL ADMINISTRATIVO DO PROPRIETÁRIO

Criar painel separado para o administrador comercial da plataforma.

Funcionalidades:

- Cadastrar empresas.
- Criar planos.
- Definir limites contratados.
- Acompanhar assinaturas.
- Verificar pagamentos.
- Gerenciar solicitações de suporte.
- Visualizar indicadores de utilização agregados.
- Gerenciar configurações comerciais.

O administrador comercial não deve possuir acesso automático aos dados confidenciais das PTs.

## 17. COBRANÇA RECORRENTE

Implementar arquitetura de assinatura mensal.

Preparar integração com provedor de pagamentos que opere no Brasil.

Funcionalidades:

- Planos configuráveis.
- Assinatura mensal.
- Controle de vencimento.
- Histórico de cobrança.
- Webhooks autenticados.
- Tratamento de falhas de pagamento.
- Período de tolerância configurável.
- Cancelamento.
- Reativação.
- Emissão de comprovantes, quando disponível.

A suspensão comercial não poderá comprometer a preservação legal de documentos nem criar situações inseguras para atividades em andamento.

Nunca armazenar dados completos de cartão na aplicação.

## 18. FUNCIONALIDADES FUTURAS

Planejar a arquitetura para permitir:

- Operação offline com sincronização segura.
- Integração com sistemas de RH.
- Controle de treinamentos e certificados.
- Controle de ASO e aptidão ocupacional com acesso restrito.
- Controle de vencimentos.
- Notificações.
- Gestão de terceiros.
- Gestão de bloqueio de energias perigosas.
- Integrações via API.
- Gestão de múltiplas plantas industriais.
- Aplicativo móvel.
- Indicadores avançados.
- Assistência por IA na elaboração de APR.

A IA poderá sugerir perigos e medidas preventivas, mas nunca autorizar uma atividade ou substituir o responsável competente.

## 19. TESTES OBRIGATÓRIOS

Implementar testes automatizados para:

- Autenticação.
- Permissões.
- Isolamento multiempresa.
- Criação de APR.
- Emissão de PT.
- Fluxos de aprovação.
- Respostas críticas.
- Bloqueio de PT insegura.
- Anexos.
- Assinaturas.
- Geração de PDF.
- Integridade de documentos.
- Retenção.
- Pagamentos.
- Falhas de conexão.
- Concorrência entre usuários.
- Tentativas de acesso não autorizado.

Criar testes ponta a ponta dos fluxos principais.

Nenhuma funcionalidade de segurança deverá ser considerada concluída apenas porque a interface funciona.

## 20. PLANO DE EXECUÇÃO

Não tente desenvolver todo o sistema de uma única vez.

Primeiro, analise os requisitos e produza:

1. Documento de visão do produto.
2. Pesquisa normativa e matriz de conformidade.
3. Requisitos funcionais e não funcionais.
4. Arquitetura técnica.
5. Modelo de dados.
6. Modelo de autorização.
7. Fluxos de APR e PT.
8. Protótipo navegável das telas.
9. Plano de segurança.
10. Roadmap de desenvolvimento por fases.

Depois implemente em etapas:

**Fase 1 — Fundação**
- Estrutura do projeto.
- Banco de dados.
- Autenticação.
- Empresas.
- Usuários.
- Perfis.
- Isolamento multiempresa.

**Fase 2 — APR**
- Modelos.
- Perguntas.
- Respostas.
- Fotografias.
- Avaliação de riscos.
- Salvamento.
- Histórico.

**Fase 3 — PT**
- Vinculação à APR.
- Fluxos de aprovação.
- Bloqueios.
- Assinaturas.
- Estados.
- Encerramento.

**Fase 4 — Documentos**
- PDFs.
- Arquivamento.
- Consulta.
- Auditoria.
- Retenção.

**Fase 5 — Comercialização**
- Painel administrativo.
- Planos.
- Assinaturas.
- Cobranças.
- Gestão comercial.

**Fase 6 — Homologação**
- Testes de segurança.
- Testes de carga.
- Validação com profissionais de SST.
- Revisão jurídica.
- Homologação com empresas piloto.
- Preparação para produção.

Em cada fase, entregue código funcional, testes, instruções de execução e documentação.

Não declare o sistema pronto para produção sem evidências de testes e homologação.

## 21. ENTREGÁVEIS

Quero receber:

- Código-fonte organizado.
- README completo.
- Docker Compose para desenvolvimento.
- Migrações do banco.
- Dados fictícios para demonstração.
- Testes automatizados.
- Documentação das APIs.
- Documentação da arquitetura.
- Guia de instalação.
- Guia de implantação.
- Checklist de segurança.
- Matriz normativa.
- Lista de pendências para homologação.

Não utilizar dados reais de trabalhadores nos testes.

## 22. INSTRUÇÃO FINAL

Trate este projeto como um produto SaaS comercial sério, destinado a empresas que realizam atividades com riscos ocupacionais.

Priorize segurança, confiabilidade, rastreabilidade, conformidade, desempenho e facilidade de utilização.

Não simplifique requisitos críticos para acelerar a implementação.

Sempre que encontrar uma dúvida normativa, técnica ou de negócio que possa comprometer a solução, documente-a e solicite minha decisão antes de implementar.

Comece apresentando a arquitetura proposta, o planejamento por fases e as decisões que precisam da minha aprovação.

Após essa apresentação, inicie a implementação da primeira fase quando eu autorizar.
