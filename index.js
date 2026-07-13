const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

const zapi = axios.create({
  baseURL: `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}`,
});

const claude = new Anthropic({ apiKey: ANTHROPIC_KEY });
const historico = new Map();

function obterHistorico(telefone) {
  if (!historico.has(telefone)) historico.set(telefone, []);
  return historico.get(telefone);
}

function adicionarMensagem(telefone, role, content) {
  const msgs = obterHistorico(telefone);
  msgs.push({ role, content });
  if (msgs.length > 20) msgs.splice(0, msgs.length - 20);
}

const SYSTEM_PROMPT = `Você é o assistente jurídico virtual do escritório M VOLPE AGUERRI SOCIEDADE INDIVIDUAL DE ADVOCACIA, representado pelo Dr. Marcelo Volpe Aguerri (OAB/SP nº 271.795 | OAB/SC nº 35.198-A), em Balneário Camboriú/SC. Recepcione clientes, entenda o problema jurídico brevemente, colete nome e área do problema, e informe que o Dr. Marcelo entrará em contato. Responda de forma clara, cordial e profissional. Respostas curtas (máximo 3 parágrafos). Nunca garanta resultados. Sempre finalize com: "Este atendimento tem finalidade informativa. Para orientação jurídica individualizada, o Dr. Marcelo Aguerri entrará em contato." Contato: marcelo@mvolpe.adv.br | (47) 99986-0723`;

async function enviarMensagem(telefone, texto) {
  await zapi.post("/send-text", { phone: telefone, message: texto });
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.fromMe) return;
    const texto = body?.text?.message || body?.message;
    if (!texto || typeof texto !== "string") return;
    const telefone = body.phone;
    if (!telefone) return;
    adicionarMensagem(telefone, "user", texto);
    const resposta = await claude.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: obterHistorico(telefone),
    });
    const respostaTexto = resposta.content[0].text;
    adicionarMensagem(telefone, "assistant", respostaTexto);
    await enviarMensagem(telefone, respostaTexto);
  } catch (erro) {
    console.error("Erro:", erro.message);
  }
});

app.get("/", (req, res) => res.send("Agente M Volpe Aguerri — online ✅"));

app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
