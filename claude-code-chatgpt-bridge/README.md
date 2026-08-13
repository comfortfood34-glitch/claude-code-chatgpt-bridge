# Ponte privada ChatGPT → Claude Code Web

Servidor MCP privado que permite ao ChatGPT iniciar uma sessão real do Claude Code Web por meio da API oficial de Rotinas da Anthropic.

## Segurança aplicada

- O token da rotina e o token de acesso à ponte ficam apenas nas variáveis secretas do servidor.
- A URL de destino é restrita ao endpoint oficial `api.anthropic.com` para impedir chamadas arbitrárias.
- O modo padrão é somente leitura.
- A rotina deve ser configurada sem deploy automático e sem alterações em produção.
- Cada solicitação cria uma nova sessão do Claude Code e retorna seu link.

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

Após a implantação, confirme que `https://SEU-SERVICO.onrender.com/health` retorna `status: ok`.

## 3. Conectar ao ChatGPT

Cadastre o servidor MCP privado usando:

- URL: `https://SEU-SERVICO.onrender.com/mcp`
- Autenticação: Bearer token
- Token: o mesmo valor de `BRIDGE_ACCESS_TOKEN`

O plugin expõe a ferramenta `send_to_claude_code`, com os modos `read_only` e `implementation`.

## Limitação oficial

A API experimental de Rotinas inicia a sessão e devolve o link, mas não transmite a saída nem aguarda a conclusão. Para ver o resultado ou continuar, abra o link retornado pelo plugin.
