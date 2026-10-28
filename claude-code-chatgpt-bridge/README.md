# Ponte privada ChatGPT → Claude Code Web

Servidor MCP privado que permite ao ChatGPT iniciar uma sessão real do Claude Code Web por meio da API oficial de Rotinas da Anthropic.

## Segurança aplicada

- O token da rotina e o token de acesso à ponte ficam apenas nas variáveis secretas do servidor.
- A URL de destino é restrita ao endpoint oficial `api.anthropic.com` para impedir chamadas arbitrárias.
- O modo padrão é somente leitura.
- A rotina deve ser configurada sem deploy automático e sem alterações em produção.
- A rotina cria uma sessão nova somente após autorização explícita; complementos de projeto usam uma conversa já existente.
- Ao terminar, o Claude envia o relatório à ponte por um callback assinado e temporário.

## 1. Criar a rotina no Claude Code

1. Acesse `https://claude.ai/code/routines`.
2. Crie uma rotina conectada ao repositório desejado.
3. Use como instrução permanente:

   `Trabalhe somente no repositório configurado. Obedeça ao modo informado na tarefa. Em modo somente leitura, não altere arquivos, não crie commits e não faça deploy. Em modo implementação, nunca faça deploy ou alteração de produção e apresente diff e testes para revisão humana.`

4. Em **Select a trigger**, escolha **API**.
5. Gere o token. Copie a URL completa e o token nesse momento; o token aparece uma única vez.

## 2. Implantar no Render

Crie um novo Blueprint apontando para este projeto. Configure os segredos solicitados:

- `CLAUDE_ROUTINE_FIRE_URL`: URL completa fornecida pela rotina.
- `CLAUDE_ROUTINE_TOKEN`: token da rotina iniciado por `sk-ant-oat01-`.
- `BRIDGE_ACCESS_TOKEN`: segredo longo usado pelo ChatGPT para acessar a ponte.
- `BRIDGE_PUBLIC_URL`: URL pública da ponte, por exemplo `https://claude-code-chatgpt-bridge.onrender.com`.

Após a implantação, confirme que `https://SEU-SERVICO.onrender.com/health` retorna `status: ok`.

## 3. Conectar ao ChatGPT

Cadastre o servidor MCP privado usando:

- URL: `https://SEU-SERVICO.onrender.com/mcp?key=SEU_BRIDGE_ACCESS_TOKEN`
- Autenticação: sem autenticação (o segredo já está incorporado na URL privada)

Não compartilhe, registre em capturas ou envie essa URL completa por mensagens. Se ela for exposta, gere um novo `BRIDGE_ACCESS_TOKEN` no Render e atualize a configuração do plugin.

O plugin expõe `send_to_claude_code`, com os modos `read_only` e `implementation`, e `get_claude_code_result`, que traz o relatório final de volta ao ChatGPT.

## Funcionamento do retorno

A API experimental de Rotinas inicia a sessão, mas não transmite sua saída. Por isso, a ponte inclui no prompt um callback assinado. Quando o Claude termina, publica o relatório nesse callback. O ChatGPT consulta o resultado usando o código de acompanhamento. Resultados ficam em memória por 24 horas; uma reinicialização do serviço gratuito do Render pode removê-los.


## 4. Conversas persistentes por projeto (sem abrir nova rotina)

**Use `continue_claude_code_session` quando o usuário pedir um complemento.**

**Compatibilidade com conexões antigas do ChatGPT:** se o cliente ainda só enxergar `send_to_claude_code`, use a tarefa começando por `PROJECT: zas` seguido de uma quebra de linha e a mensagem. A ferramenta antiga encaminha essa mensagem à sessão já cadastrada. Sem prefixo, retorna erro e nunca inicia outra sessão. Criar uma sessão realmente nova exige `create_new_session:true`, disponível somente após atualização da definição da ferramenta no ChatGPT.
A ferramenta antiga `send_to_claude_code` usa a API de rotinas e **sempre cria uma nova sessão**; agora exige `create_new_session:true` explícito. Para continuar projetos, use sempre a nova ferramenta.

O CLI oficial do Claude Code permite enviar um complemento à sessão em nuvem existente com:

```bash
claude -p "Mensagem adicional" --cloud cse_SESSAO_EXISTENTE
```

O conector usa esse mecanismo com `spawn` sem shell, recebe a mensagem por stdin, valida IDs e nunca abre uma sessão alternativa em caso de erro. O complemento inclui um callback assinado para que `get_claude_code_result` acompanhe o resultado do mesmo chat.

### Configuração no Render

1. Em **Environment**, defina `CLAUDE_PROJECT_SESSIONS` como um JSON com os projetos e os IDs das conversas já existentes, por exemplo:
   `{"zas":"cse_SESSAO_EXISTENTE","kaisosystem":"cse_OUTRA_SESSAO"}`.
   IDs inválidos e projetos não cadastrados são rejeitados: **não há fallback para criar uma nova sessão**.
2. Instale o Claude Code CLI no build: o comando `npm run build` executa `tsc`, os testes Node e instala uma versão fixada do CLI em `node_modules/.bin/claude`. O servidor usa o CLI no `PATH` do script `yarn start`.
3. Autentique o CLI na **mesma conta claude.ai que possui essas sessões**. O token de rotina `CLAUDE_ROUTINE_TOKEN` **não serve** para este fluxo. Para ambiente automatizado, o CLI aceita `CLAUDE_CODE_OAUTH_TOKEN`. Gere-o com o procedimento oficial `claude setup-token` num terminal confiável, quando disponível na sua conta, e defina-o **somente** no painel secreto do Render. Não envie tokens por chat, não adicione a GitHub e não registre em logs.
4. Consulte `get_claude_project_sessions`. Ele informa as sessões fixas e se a credencial do CLI está configurada, mas **não testa autenticação nem envia mensagens**.
5. Envie um complemento com `continue_claude_code_session` e `project:"zas"`; confira que a resposta aponta para o mesmo ID. O CLI retorna assim que enfileira a mensagem e não espera sua conclusão; o relatório chega depois pelo callback.
6. Se o OAuth expirar, ou a sessão for arquivada, a ferramenta retorna erro. Resolva a autenticação ou escolha conscientemente outra sessão; ela **não cria uma conversa nova automaticamente**.

**Acesso e segurança:** ChatGPT deve controlar as tarefas. O comando não usa `shell:true`, não retorna saída bruta do CLI e só envia mensagens para IDs cadastrados na variável do servidor. A autenticação da conta é mais ampla que o token limitado de uma rotina, portanto o token deve ser tratado como segredo de alto privilégio. A publicação no Render não deve ser feita antes de revisar os testes e provisionar a credencial de forma segura.

### Limites atuais

- O CLI pode exigir reautorização periódica; não é garantido que um token funcione indefinidamente.
- A API pública de rotina não oferece continuação; a ponte precisa do CLI autenticado. Não tente simular isso reenviando a rotina.
- Um callback depende da execução do Claude na sessão existente; o comando de envio apenas comprova que o complemento foi aceito para a fila.
- Projetos novos precisam de uma conversa criada e de registro explícito do ID no Render. Isso evita conversas duplicadas por acidente.


## 5. Mac Relay — a mesma sessão Claude, sem OAuth remoto no Render

A API de rotina sempre inicia sessão nova; o CLI no Render não consegue continuar cloud sessions usando apenas o token de \`claude setup-token\`. O login completo de \`claude auth login\` no Mac **já foi validado** para enviar à sessão existente usando \`claude -p --cloud cse_...\`.

Esta integração permite que o ChatGPT envie uma mensagem autenticada ao MCP, o Render a guarde no Redis, e um processo local do Mac faça polling HTTPS autenticado para encaminhar a mensagem à conversa **já existente** do Claude Code. **O Mac inicia todas as conexões; nenhum SSH ou porta pública é necessário.**

### Parâmetros

- \`REDIS_URL\` existente é obrigatório (fila persistente nos redeploys).
- \`CLAUDE_MAC_RELAY_TOKEN\`: token independente de alta entropia. Não usar \`CLAUDE_CODE_OAUTH_TOKEN\` nem \`BRIDGE_ACCESS_TOKEN\` aqui.
- \`CLAUDE_PROJECT_SESSIONS\`: JSON de projeto -> ID da conversa existente. O relay do ZAS valida o ID exato na configuração do Mac.

### Endpoints somente para dispositivo autenticado

- \`GET /relay/next\`: entrega no máximo uma mensagem da fila, sem retry automático se a entrega ficar incerta.
- \`POST /relay/ack\`: registra entrega aceita ou erro seguro \`claude_relay_*\`.
- \`GET /relay/status\`: estado da conexão recente do dispositivo.

A autenticação usa Bearer \`CLAUDE_MAC_RELAY_TOKEN\` com comparação de tempo constante. Falha fechada se a variável estiver ausente. Nenhuma mensagem cria sessão nova e a mesma sessão é conferida no dispositivo.

A conexão Mac é feita pelo instalador do usuário (LaunchAgent do macOS), aproveitando seu login pré-existente do Claude Code CLI. O instalador e o arquivo \`relay-config.json\` individual **não devem ser enviados ao GitHub**: o arquivo contém a credencial do dispositivo. Use sempre um pacote distribuído de forma privada.

### Comportamento

- Quando \`CLAUDE_MAC_RELAY_TOKEN\` está definido, os dois caminhos de continuação (\`continue_claude_code_session\` e compatibilidade \`send_to_claude_code\` com \`PROJECT: zas\`) **enfileiram** a mensagem no Redis, retornando job ID imediatamente. Não afirmam que Claude recebeu enquanto Mac não confirmar.
- O Mac envia com \`claude -p --cloud <existing-id>\` pela conta já autenticada, e confirma no servidor; \`get_claude_code_result\` passa a \`sent\`, aguardando callback de resultado.
- Mac desligado/offline: fila fica pendente; a próxima inicialização pode retomar. Se um processo for interrompido **depois** de retirar o job da fila, ele não é repetido automaticamente para evitar duplicações.
- Os relatórios de Claude ainda dependem da instrução de callback e podem ser consultados pela aba do Chrome se o callback faltar.
- A máquina precisa estar ligada e conectada; agentes podem continuar a pedir aprovações próprias da Anthropic para ações sensíveis.


## 6. Grok — revisão independente de PRs do ZAS

Não altera o site ZAS nem o fluxo Claude. Sem auto-merge, deploy ou aprovação automática.

### Configuração no Render

- `XAI_API_KEY`: chave de inferência xAI, só no ambiente secreto (já solicitada ao dono).
- `GROK_GITHUB_TOKEN`: token fine-grained dedicado ao repositório `comfortfood34-glitch/soyzas`, com Contents Read, Pull requests Read e Issues Write (os relatórios são comentários, não aprovações). Uma GitHub App pode fornecer installation token renovado externamente; esta implementação não renova tokens de App.
- `GROK_WEBHOOK_SECRET`: segredo aleatório de pelo menos 32 caracteres; use o mesmo no webhook GitHub.
- `REDIS_URL`: obrigatória para fila persistente e deduplicação de entregas.
- Opcionais: `XAI_REVIEW_MODEL` (padrão `grok-4.7`), `GROK_MAX_REVIEWS_PER_DAY` (padrão 20, máximo 100).

Nunca compartilhar tokens por conversa ou adicionar valores ao repositório. Esta versão não lê nem reutiliza credenciais do conector GitHub do ChatGPT.

### Webhook

Em Settings → Webhooks do **soyzas**, cadastrar:

- URL `https://claude-code-chatgpt-bridge.onrender.com/webhooks/github/grok`
- Content type `application/json`
- Secret igual a `GROK_WEBHOOK_SECRET`
- Somente evento Pull requests. Eventos opened/reopened/synchronize/ready_for_review disparam a revisão; comentários não disparam loops.

Habilitar apenas depois de configurar as credenciais. Payload precisa de assinatura HMAC SHA-256; repositórios diferentes são ignorados. Entregas são deduplicadas pelo delivery ID por sete dias, incluindo eventos ignorados pelo limite diário (resposta 202 skipped, sem migração para o orçamento do dia seguinte). Eventos distintos podem revisar o mesmo SHA; o limite diário contém o custo, mas não é um orçamento monetário. Não há varredura inicial automática das PRs existentes: solicitar cada PR pela ferramenta autenticada.

### Ferramentas MCP novas

Atualizar a definição do conector após publicar esta versão:

- `get_grok_status`: presença de configuração sem valores; `probe=true` verifica acesso a `/v1/models` sem geração. Isso não comprova saldo ou inferência.
- `review_github_pr_with_grok`: repository fixo `comfortfood34-glitch/soyzas`, pr_number e publish (padrão true). Retorna job_id.
- `get_grok_review_result`: queued/running/completed/error e relatório para o SHA analisado.

Worker consome uma tarefa por vez. Fila e resultados ficam no Redis; resultados expiram em sete dias. Até 100.000 caracteres de patches por tarefa, divididos em blocos de até 20.000. Cada chamada xAI usa streaming SSE, reasoning.effort=low explícito, JSON Schema, limite de 8.000 tokens de saída e timeout de 900 segundos. Uma revisão pode envolver várias chamadas; limite diário conta tarefas, não chamadas nem dinheiro. Arquivos de credenciais comuns são excluídos e padrões comuns de tokens redigidos, mas não há garantia de detectar todo segredo em código: nenhum segredo deve estar em PRs. Conteúdo é enviado à xAI com `store:false`. O relatório lista arquivos omitidos e limitações. Não executa código nem testes.

Jobs interrompidos **depois** de iniciar não são reenviados automaticamente, evitando custos e comentários duplicados em resultado incerto; consulta após vinte minutos sem heartbeat informa falha. Nova solicitação consciente é necessária. Render Free pode dormir sem tráfego; webhooks acordam o serviço, mas não há SLA de processamento imediato. Para operação contínua, avaliar serviço sempre ativo.

Se HEAD mudar durante a análise, o resultado fica marcado desatualizado e não é comentado na PR. Há ainda uma pequena janela entre a última leitura de HEAD e o comentário; o SHA explícito permanece a referência. Revisão é orientação técnica: nenhum achado não significa ausência de falhas. O coordenador deve validar os achados antes de encaminhar correções ao Claude. Encaminhamento automático Claude e revisão de todas as PRs históricas não fazem parte desta versão.

### Validação

`npm test`: TypeScript + testes locais com rede simulada para assinatura, allowlist de repositório/evento, omissão de segredos, contrato xAI, vínculo ao SHA e bloqueio de publicação de relatório desatualizado. Fila Redis e ponta a ponta em contas reais exigem validação no ambiente configurado; não foram comprovados só por esses testes.


### Alternativa sem cadastrar webhook: polling

`GROK_POLL_ENABLED=true` consulta a cada minuto até 100 PRs abertas (mais recentemente atualizadas primeiro), inclusive rascunhos. Cada PR+SHA recebe uma revisão por sete dias. Usa a mesma fila e limite diário; após atingir o limite, a consulta interrompe o lote. No polling, um recibo de orçamento pode ser reavaliado quando há quota disponível; eventos webhook ignorados continuam terminais pela retenção. Não precisa de permissão Administration nem de GROK_WEBHOOK_SECRET. Usar polling OU webhook para evitar revisões duplicadas por eventos de origens distintas. Ao iniciar, o servidor escreve somente códigos sanitizados de acesso xAI/models e GitHub/PRs nos logs (sem valores de credenciais, conteúdo das PRs ou respostas brutas). O probe não comprova saldo/inferência ou permissão de escrita; uma revisão real precisa completar e comentar para confirmar o fluxo.

Render Free pode dormir apesar de timers internos. Polling não garante vigilância contínua se a instância estiver suspensa por inatividade; para SLA contínuo, usar webhook com tráfego ou serviço sempre ativo. Ativar polling envia patches das PRs à xAI e consome a API, dentro do limite de tarefas (não teto monetário).


### Revisões por blocos e diagnóstico

As partes de um arquivo grande preservam caminho e número do fragmento, mas revisão fragmentada pode perder relações entre arquivos. O relatório explicita essa limitação. Antes de cada bloco o HEAD é conferido; mudança cancela a análise. Depois de cada bloco, o resultado validado e redigido é salvo no Redis no progresso da tarefa. Falha posterior mantém esse checkpoint para inspeção; não há retomada nem cobrança automática de blocos incertos. Um relatório só é publicado após concluir todos os blocos e conferir HEAD novamente. Falha não publica um parecer parcial como concluído.

O worker renova sua lease a cada 30 segundos sem reserializar os checkpoints (preserva arrays JSON vazios) e registra progresso (etapa, blocos concluídos, total, SHA) sem conteúdo ou segredos. Erros de timeout da xAI, rede e JSON/esquema inválido têm códigos diferentes. A leitura de status do conector informa a etapa atual, em vez de apenas running.

Compatibilidade para clientes com catálogo MCP antigo: `send_to_claude_code` aceita os comandos exatos `GROK_STATUS` e `GROK_REVIEW: 955`; eles não enviam mensagem nem criam sessão Claude. `get_claude_code_result` também consulta um UUID de revisão Grok quando não há tarefa Claude correspondente. As ferramentas continuam autenticadas pelo OAuth da ponte.

Testes novos: SSE fragmentado e UTF-8, conclusão obrigatória, divisão de patch sem perda, erros sanitizados, checkpoint antes de falha e nenhuma publicação incompleta. Validação real de inferência e comentário deve ser documentada separadamente dos mocks.
