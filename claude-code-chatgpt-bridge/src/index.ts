import express, { type Request, type Response } from "express";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { fireClaudeRoutine } from "./claude.js";
import { cloudFollowupReady, parseFollowupTask, parseProjectSessions, projectSessionId, queueCloudFollowup } from "./cloud-followup.js";
import { attachSession, completeJob, createJob, failJob, getJob, markJobSent } from "./jobs.js";
import { ackMacFollowup, authorizedRelayToken, claimMacFollowup, enqueueMacFollowup, readMacRelayState } from "./mac-relay.js";

import { grokConfiguration, probeGrok, ReviewRequest, validSignature, webhookReview } from "./grok.js";
import { enqueueReview, getReviewJob, startGrokWorker } from "./grok-queue.js";

const app = express();
app.disable("x-powered-by"); app.set("trust proxy", 1);
// Raw body is required to authenticate GitHub; mount before JSON parsing.
app.post("/webhooks/github/grok", express.raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
  const secret = process.env.GROK_WEBHOOK_SECRET ?? "";
  if (secret.length < 32) { res.status(503).json({ error: "webhook_not_configured" }); return; }
  if (!Buffer.isBuffer(req.body) || !validSignature(req.body, req.header("x-hub-signature-256") ?? "", secret)) { res.status(401).json({ error: "invalid_signature" }); return; }
  try {
    const input = webhookReview(req.header("x-github-event") ?? "", JSON.parse(req.body.toString("utf8")));
    if (!input) { res.status(200).json({ ignored: true }); return; }
    const delivery = req.header("x-github-delivery") ?? "";
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(delivery)) { res.status(400).json({ error: "invalid_delivery_id" }); return; }
    res.status(202).json(await enqueueReview(input, delivery));
  } catch { res.status(503).json({ error: "review_queue_unavailable_or_daily_limit" }); }
});
app.use(express.json({ limit: "80kb" })); app.use(express.urlencoded({ extended: false }));
type Payload = Record<string, unknown> & { exp: number; kind: string };
const bridgeSecret = () => {
  const value = process.env.BRIDGE_ACCESS_TOKEN;
  if (!value || value.length < 32) throw new Error("BRIDGE_ACCESS_TOKEN must be at least 32 characters.");
  return value;
};
const baseUrl = (req: Request) => `${req.protocol}://${req.get("host")}`;
const sign = (payload: Payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", bridgeSecret()).update(body).digest("base64url")}`;
};
function verify(token: string, kind: string): Payload | undefined {
  const [body, signature] = token.split("."); if (!body || !signature) return;
  const expected = createHmac("sha256", bridgeSecret()).update(body).digest("base64url");
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()) as Payload; return p.kind === kind && p.exp > Date.now() / 1000 ? p : undefined; } catch { return; }
}
function safeRedirect(value: string) {
  try { const u = new URL(value); return u.protocol === "https:" && (u.hostname === "chatgpt.com" || u.hostname.endsWith(".openai.com")); } catch { return false; }
}
const esc = (value: string) => value.replace(/[&<>'"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[c]!);
function requireAuth(req: Request, res: Response) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (verify(token, "access")) return true;
  res.set("WWW-Authenticate", `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource/mcp"`);
  res.status(401).json({ error: "unauthorized" }); return false;
}

function mcpServer() {
  const server = new McpServer({ name: "Claude Code Bridge", version: "0.3.0" });
  server.registerTool("send_to_claude_code", {
    title: "Enviar tarefa ao Claude Code",
    description: "ATENÇÃO: inicia uma sessão NOVA. Para continuar o trabalho do projeto na MESMA conversa, use continue_claude_code_session; só use esta ferramenta quando o usuário pedir expressamente uma nova sessão.",
    inputSchema: { task: z.string().min(1).max(65_536), mode: z.enum(["read_only", "implementation"]).default("read_only"), create_new_session: z.boolean().default(false) }
  }, async ({ task, mode, create_new_session }) => {
    if (!create_new_session) {
      // Legacy ChatGPT installations still expose the old two-tool MCP schema.
      // Explicit project label prevents accidental routing into an unrelated session.
      const followup = parseFollowupTask(task);
      const sessionId = projectSessionId(followup.project);
      if (!process.env.CLAUDE_MAC_RELAY_TOKEN && !cloudFollowupReady()) throw new Error("claude_delivery_not_configured");
      const { job, callbackToken } = await createJob();
      await attachSession(job.id, sessionId, "https://claude.ai/code/" + sessionId);
      const publicUrl = (process.env.BRIDGE_PUBLIC_URL ?? "https://claude-code-chatgpt-bridge.onrender.com").replace(/\/$/, "");
      const rule = mode === "read_only"
        ? "MODO SOMENTE LEITURA: não modifique arquivos, commits ou dados."
        : "MODO IMPLEMENTAÇÃO: alterações só no repositório desta sessão. Sem publicação, deploy ou pagamento LIVE.";
      const callback = "\n\nRETORNO OBRIGATÓRIO: ao terminar esta tarefa, envie HTTP POST para " +
        publicUrl + "/callbacks/claude/" + job.id + " com JSON " +
        JSON.stringify({ token: callbackToken, status: "completed", result: "RELATÓRIO FINAL COMPLETO" }) +
        ". Não exponha tokens. Não crie outra sessão.";
      try {
        if (process.env.CLAUDE_MAC_RELAY_TOKEN) await enqueueMacFollowup(job.id, sessionId, rule + "\n\n" + followup.task + callback);
        else await queueCloudFollowup(sessionId, rule + "\n\n" + followup.task + callback);
        return { content: [{ type: "text", text: "Mensagem enfileirada para envio à conversa EXISTENTE do projeto " +
          followup.project + ". Nenhuma sessão nova criada.\nCódigo de acompanhamento: " +
          job.id + "\nSessão: https://claude.ai/code/" + sessionId +
          "\nConsulte get_claude_code_result para receber o relatório." }] };
      } catch (error) {
        await failJob(job.id, error instanceof Error ? error.message : "Falha ao enviar complemento");
        throw error;
      }
    }
    const rule = mode === "read_only"
      ? "MODO OBRIGATÓRIO: somente leitura. Não edite, não faça commit ou deploy e não altere dados.\n\n"
      : "MODO IMPLEMENTAÇÃO: não faça deploy nem altere produção. Apresente diff e testes para revisão.\n\n";
    const { job, callbackToken } = await createJob();
    const publicUrl = (process.env.BRIDGE_PUBLIC_URL ?? "https://claude-code-chatgpt-bridge.onrender.com").replace(/\/$/, "");
    const callbackInstruction = `

RETORNO OBRIGATÓRIO AO CHATGPT:
Ao terminar todo o trabalho, envie seu relatório final por HTTP POST para:
${publicUrl}/callbacks/claude/${job.id}
JSON obrigatório: {"token":"${callbackToken}","status":"completed","result":"SEU RELATÓRIO FINAL COMPLETO"}
Use status "error" se não conseguir concluir. Faça essa chamada apenas uma vez e somente ao final. Não revele o token no relatório ou em arquivos. Esta chamada de retorno não é deploy nem alteração de produção.
`;
    try {
      const result = await fireClaudeRoutine(rule + task + callbackInstruction);
      await attachSession(job.id, result.claude_code_session_id, result.claude_code_session_url);
      return { content: [{ type: "text", text: `Sessão iniciada.\nCódigo de acompanhamento: ${job.id}\nID da sessão: ${result.claude_code_session_id}\nAbrir: ${result.claude_code_session_url}\nPara receber a resposta aqui, use get_claude_code_result com o código de acompanhamento.` }] };
    } catch (error) {
      await failJob(job.id, error instanceof Error ? error.message : "Falha ao iniciar a sessão.");
      throw error;
    }
  });
  server.registerTool("get_claude_project_sessions", {
    title: "Consultar sessões persistentes por projeto",
    description: "Lista os projetos com sessão Claude Code fixa, sem abrir qualquer sessão ou enviar mensagens. Indica se a autenticação do CLI foi configurada.",
    inputSchema: {}
  }, async () => {
    const sessions = parseProjectSessions(process.env.CLAUDE_PROJECT_SESSIONS);
    return { content: [{ type: "text", text: JSON.stringify({
      projects: Object.entries(sessions).map(([project, session_id]) => ({
        project, session_id, url: "https://claude.ai/code/" + session_id
      })),
      cli_oauth_configured: cloudFollowupReady(),
      relay: await readMacRelayState().catch(() => ({enabled:true,active:false,lastSeen:null})),
      note: "Sessões persistentes não são criadas automaticamente."
    }) }] };
  });
  server.registerTool("continue_claude_code_session", {
    title: "Continuar conversa existente no Claude Code",
    description: "ENVIA À MESMA CONVERSA cloud de um projeto; não cria sessão. Só funciona quando a sessão está mapeada e o CLI autenticado. Retorna job_id para get_claude_code_result.",
    inputSchema: {
      project: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
      task: z.string().min(1).max(50_000),
      mode: z.enum(["read_only", "implementation"]).default("read_only")
    }
  }, async ({ project, task, mode }) => {
    const sessionId = projectSessionId(project);
    if (!process.env.CLAUDE_MAC_RELAY_TOKEN && !cloudFollowupReady()) {
      throw new Error("claude_delivery_not_configured");
    }
    const { job, callbackToken } = await createJob();
    await attachSession(job.id, sessionId, "https://claude.ai/code/" + sessionId);
    const publicUrl = (process.env.BRIDGE_PUBLIC_URL ?? "https://claude-code-chatgpt-bridge.onrender.com").replace(/\/$/, "");
    const rule = mode === "read_only"
      ? "MODO SOMENTE LEITURA: não faça edições, commits, deploy nem alterações em dados."
      : "MODO IMPLEMENTAÇÃO: trabalhe somente no repositório da sessão existente. Sem deploy, sem alterar produção ou pagamentos LIVE. Realize testes locais, apresente commits e PR para revisão.";
    const callback = "\n\nRETORNO OBRIGATÓRIO AO CHATGPT: quando terminar esta tarefa, envie UMA chamada HTTP POST para " +
      publicUrl + "/callbacks/claude/" + job.id + " com JSON {\"token\":\"" + callbackToken +
      "\",\"status\":\"completed\",\"result\":\"RELATÓRIO FINAL COMPLETO\"}. Use status error se falhar. Não exponha tokens no relatório. Não inicie outra sessão.";
    try {
      if (process.env.CLAUDE_MAC_RELAY_TOKEN) await enqueueMacFollowup(job.id, sessionId, rule + "\n\n" + task + callback);
      else await queueCloudFollowup(sessionId, rule + "\n\n" + task + callback);
      return { content: [{ type: "text", text:
        "Mensagem enfileirada para sessão EXISTENTE do projeto " + project +
        ". Nenhuma sessão nova foi criada.\nCódigo de acompanhamento: " + job.id +
        "\nSessão: https://claude.ai/code/" + sessionId +
        "\nAcompanhe via get_claude_code_result."
      }] };
    } catch (error) {
      await failJob(job.id, error instanceof Error ? error.message : "Falha ao enviar o complemento.");
      throw error;
    }
  });
  server.registerTool("get_claude_code_result", {
    title: "Consultar resposta do Claude Code",
    description: "Consulta o andamento e, quando concluído, traz a resposta final do Claude Code para o ChatGPT.",
    inputSchema: { job_id: z.string().uuid() }
  }, async ({ job_id }) => {
    const job = await getJob(job_id);
    if (!job) return { content: [{ type: "text", text: "Tarefa não encontrada ou expirada. Os resultados ficam disponíveis por 24 horas." }] };
    if (job.status === "running") return { content: [{ type: "text", text: `Tarefa enfileirada ou aguardando resposta do Claude.\nSessão: ${job.sessionUrl ?? "iniciando"}` }] };
    return { content: [{ type: "text", text: `Status: ${job.status}\nSessão: ${job.sessionUrl ?? "indisponível"}\n\nResposta do Claude Code:\n${job.result ?? "Sem relatório."}` }] };
  });
  server.registerTool("get_grok_status", {
    title: "Verificar integração Grok", description: "Mostra apenas presença das configurações. probe=true verifica acesso a modelos, sem enviar código nem gastar tokens de geração.",
    inputSchema: { probe: z.boolean().default(false) }
  }, async ({ probe }) => ({ content: [{ type: "text", text: JSON.stringify({ ...grokConfiguration(), ...(probe ? { probe: await probeGrok() } : {}) }) }] }));
  server.registerTool("review_github_pr_with_grok", {
    title: "Solicitar revisão Grok de PR do ZAS", description: "Enfileira análise de diffs via API xAI. Pode publicar relatório na PR, nunca aprova nem faz merge. Retorna job_id; consultar get_grok_review_result.",
    inputSchema: ReviewRequest.shape
  }, async (input) => ({ content: [{ type: "text", text: JSON.stringify(await enqueueReview(input)) }] }));
  server.registerTool("get_grok_review_result", {
    title: "Consultar revisão Grok", description: "Estado real queued/running/completed/error e relatório associado ao SHA analisado.", inputSchema: { job_id: z.string().uuid() }
  }, async ({ job_id }) => ({ content: [{ type: "text", text: JSON.stringify(await getReviewJob(job_id)) }] }));
  return server;
}

// Dedicated server-to-server API for the owner-private Kai Office.
function requireOfficeAuth(req: Request, res: Response): boolean {
  const configured = process.env.KAI_OFFICE_ACCESS_TOKEN;
  const provided = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!configured || configured.length < 32) { res.status(503).json({ error: "office_not_configured" }); return false; }
  const a = Buffer.from(provided), b = Buffer.from(configured);
  if (a.length !== b.length || !timingSafeEqual(a, b)) { res.status(401).json({ error: "unauthorized" }); return false; }
  return true;
}
app.get("/office/status", async (req, res) => {
  if (!requireOfficeAuth(req, res)) return;
  let providerStatus: number | null = null;
  if (req.query.probe === "1") {
    const target = process.env.CLAUDE_ROUTINE_FIRE_URL ?? "";
    if (/^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9_-]+\/fire$/.test(target)) {
      try { const probe = await fetch(target, { method: "GET", headers: { Authorization: "Bearer " + (process.env.CLAUDE_ROUTINE_TOKEN ?? ""), "anthropic-version": "2023-06-01", "anthropic-beta": "experimental-cc-routine-2026-04-01" }, signal: AbortSignal.timeout(15000) }); providerStatus = probe.status; } catch { /* No retry. */ }
    }
  }
  res.set("Cache-Control", "no-store").json({ status: "ok", routine_configured: Boolean(process.env.CLAUDE_ROUTINE_TOKEN && process.env.CLAUDE_ROUTINE_FIRE_URL), storage: process.env.REDIS_URL ? "redis" : "memory", provider_probe_status: providerStatus });
});
app.post("/office/jobs", async (req, res) => {
  if (!requireOfficeAuth(req, res)) return;
  const parsed = z.object({ task: z.string().min(1).max(50000), mode: z.enum(["read_only", "implementation"]).default("read_only") }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "invalid_task" }); return; }
  try {
    const { job, callbackToken } = await createJob();
    const publicUrl = (process.env.BRIDGE_PUBLIC_URL ?? "https://claude-code-chatgpt-bridge.onrender.com").replace(/\/$/, "");
    const rule = parsed.data.mode === "read_only" ? "MODO SOMENTE LEITURA: não edite arquivos, não faça commits, deploy nem alterações em dados." : "MODO IMPLEMENTAÇÃO: trabalhe apenas no repositório configurado. Não faça deploy nem altere produção. Apresente diff e testes para revisão.";
    const callback = `\n\nRETORNO OBRIGATÓRIO: ao terminar, envie uma única chamada HTTP POST para ${publicUrl}/callbacks/claude/${job.id} com JSON {"token":"${callbackToken}","status":"completed","result":"RELATÓRIO FINAL COMPLETO"}. Use status "error" se não concluir. Não exponha o token em relatório, arquivos ou commits. O retorno não é deploy nem alteração de produção.`;
    try {
      const session = await fireClaudeRoutine(rule + "\n\n" + parsed.data.task + callback);
      await attachSession(job.id, session.claude_code_session_id, session.claude_code_session_url);
      res.set("Cache-Control", "no-store").status(202).json({ job_id: job.id, status: "running", session_url: session.claude_code_session_url });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      const providerStatus = /Claude routine failed \((\d{3})\)/.exec(message)?.[1];
      const reason = providerStatus ? "A Anthropic recusou o início da rotina (HTTP " + providerStatus + ")." : message.includes("CLAUDE_ROUTINE") ? "A configuração da rotina Claude é inválida." : "Não foi possível confirmar o início da sessão.";
      console.error(JSON.stringify({ event: "office_routine_failed", job_id: job.id, provider_status: providerStatus ?? null, kind: message.includes("CLAUDE_ROUTINE") ? "configuration" : providerStatus ? "provider_rejection" : "unknown" }));
      await failJob(job.id, reason);
      res.status(502).json({ job_id: job.id, status: providerStatus ? "failed" : "uncertain", provider_status: providerStatus ?? null, error: reason + " Não houve reenvio automático." });
    }
  } catch { res.status(503).json({ error: "job_storage_unavailable" }); }
});
app.get("/office/jobs/:jobId", async (req, res) => {
  if (!requireOfficeAuth(req, res)) return;
  if (!z.string().uuid().safeParse(req.params.jobId).success) { res.status(400).json({ error: "invalid_job_id" }); return; }
  try {
    const job = await getJob(req.params.jobId);
    if (!job) { res.status(404).json({ error: "job_not_found_or_expired" }); return; }
    res.set("Cache-Control", "no-store").json({ job_id: job.id, status: job.status, session_url: job.sessionUrl ?? null, result: job.result ?? null });
  } catch { res.status(503).json({ error: "job_storage_unavailable" }); }
});

function requireMacRelay(req: Request, res: Response): boolean {
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (authorizedRelayToken(bearer)) return true;
  res.set("Cache-Control", "no-store").status(401).json({ error: "unauthorized" });
  return false;
}
// Pull-only: Mac initiates every connection. Claude login stays on the Mac.
app.get("/relay/next", async (req, res) => {
  if (!requireMacRelay(req, res)) return;
  try {
    const job = await claimMacFollowup();
    res.set("Cache-Control", "no-store");
    if (!job) { res.status(204).end(); return; }
    res.status(200).json({ job_id: job.id, session_id: job.sessionId, task: job.message });
  } catch { res.status(503).json({ error: "relay_storage_unavailable" }); }
});
app.post("/relay/ack", async (req, res) => {
  if (!requireMacRelay(req, res)) return;
  const parsed = z.object({
    job_id: z.string().uuid(),
    ok: z.boolean(),
    error: z.string().max(90).optional()
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "invalid_ack" }); return; }
  try {
    const { job_id, ok, error } = parsed.data;
    const state = await ackMacFollowup(job_id, ok, error);
    if (state === "ignored") { res.status(409).json({ error: "unknown_or_unclaimed_task" }); return; }
    if (state === "sent") await markJobSent(job_id);
    else await failJob(job_id, /^claude_relay_[a-z0-9_]{1,60}$/.test(error ?? "") ? error! : "claude_relay_dispatch_error");
    res.set("Cache-Control", "no-store").json({ state });
  } catch { res.status(503).json({ error: "relay_storage_unavailable" }); }
});
app.get("/relay/status", async (req, res) => {
  if (!requireMacRelay(req, res)) return;
  try { res.set("Cache-Control", "no-store").json(await readMacRelayState()); }
  catch { res.status(503).json({ error: "relay_storage_unavailable" }); }
});
app.get("/health", (_req, res) => res.json({ status: "ok", service: "claude-code-chatgpt-bridge" }));
app.post("/callbacks/claude/:jobId", async (req, res) => {
  const parsed = z.object({
    token: z.string().min(20).max(200),
    status: z.enum(["completed", "error"]),
    result: z.string().min(1).max(100_000)
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "invalid_callback" }); return; }
  const accepted = await completeJob(req.params.jobId, parsed.data.token, parsed.data.status, parsed.data.result);
  if (!accepted) { res.status(404).json({ error: "job_not_found_or_invalid_token" }); return; }
  res.json({ accepted: true });
});
app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => {
  const base = baseUrl(req); res.json({ resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"] });
});
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = baseUrl(req); res.json({ issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
});
app.post("/oauth/register", (req, res) => {
  const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.filter((x: unknown) => typeof x === "string") : [];
  if (!uris.length || !uris.every(safeRedirect)) { res.status(400).json({ error: "invalid_redirect_uri" }); return; }
  res.status(201).json({ client_id: "chatgpt-claude-code-bridge", redirect_uris: uris, token_endpoint_auth_method: "none" });
});
app.get("/oauth/authorize", (req, res) => {
  const v = { client_id:String(req.query.client_id??""), redirect_uri:String(req.query.redirect_uri??""), state:String(req.query.state??""), code_challenge:String(req.query.code_challenge??""), code_challenge_method:String(req.query.code_challenge_method??""), response_type:String(req.query.response_type??"") };
  if (v.client_id !== "chatgpt-claude-code-bridge" || v.response_type !== "code" || v.code_challenge_method !== "S256" || !safeRedirect(v.redirect_uri)) { res.status(400).send("Invalid OAuth request"); return; }
  const hidden = Object.entries(v).map(([k,x]) => `<input type="hidden" name="${k}" value="${esc(x)}">`).join("");
  res.type("html").send(`<!doctype html><html lang="pt"><meta charset="utf-8"><title>Autorizar ponte</title><style>body{font:16px system-ui;max-width:520px;margin:70px auto;padding:24px}input,button{width:100%;box-sizing:border-box;padding:12px;margin-top:12px}button{background:#111;color:#fff;border:0}</style><h1>Autorizar Claude Code — Kaiso</h1><p>Digite a senha BRIDGE_ACCESS_TOKEN salva no Render.</p><form method="post">${hidden}<input type="password" name="bridge_key" required><button>Autorizar</button></form></html>`);
});
app.post("/oauth/authorize", (req, res) => {
  const a=Buffer.from(String(req.body.bridge_key??"")), b=Buffer.from(bridgeSecret());
  if (a.length!==b.length || !timingSafeEqual(a,b)) { res.status(401).send("Senha inválida"); return; }
  const redirect=String(req.body.redirect_uri??""); if(!safeRedirect(redirect)){res.status(400).send("Redirect inválido");return;}
  const code=sign({kind:"code",exp:Math.floor(Date.now()/1000)+300,client_id:String(req.body.client_id),redirect_uri:redirect,code_challenge:String(req.body.code_challenge)});
  const target=new URL(redirect); target.searchParams.set("code",code); target.searchParams.set("state",String(req.body.state??"")); res.redirect(target.toString());
});
app.post("/oauth/token", (req,res) => {
  const code=verify(String(req.body.code??""),"code"); const challenge=createHash("sha256").update(String(req.body.code_verifier??"")).digest("base64url");
  if(!code || code.client_id!==req.body.client_id || code.redirect_uri!==req.body.redirect_uri || code.code_challenge!==challenge){res.status(400).json({error:"invalid_grant"});return;}
  res.json({access_token:sign({kind:"access",exp:Math.floor(Date.now()/1000)+2592000,sub:"chatgpt"}),token_type:"Bearer",expires_in:2592000});
});

app.post("/mcp", async (req,res) => {
  if(!requireAuth(req,res))return; const server=mcpServer(); const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
  res.on("close",()=>{void transport.close();void server.close();});
  try{await server.connect(transport);await transport.handleRequest(req,res,req.body);}catch(e){if(!res.headersSent)res.status(500).json({error:e instanceof Error?e.message:"internal_error"});}
});
app.get("/mcp",(req,res)=>{if(requireAuth(req,res))res.status(405).json({error:"method_not_allowed"});});
app.delete("/mcp",(req,res)=>{if(requireAuth(req,res))res.status(405).json({error:"method_not_allowed"});});
startGrokWorker();
const port=Number(process.env.PORT??3000);
app.listen(port,"0.0.0.0",()=>console.log(JSON.stringify({event:"server_started",port,instance:randomUUID()})));
