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
