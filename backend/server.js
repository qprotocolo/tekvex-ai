// ============================================================
// TEKVEX AI — Backend Principal
// Stack: Node.js + Express + Anthropic Claude + Supabase
// Autor: TekVex Engine
// ============================================================

import express    from 'express';
import cors       from 'cors';
import Anthropic  from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import rateLimit from 'express-rate-limit';

const app = express();

// ---------------------------------------------------------------
// SEGURANÇA — Variáveis de ambiente obrigatórias
// Nenhuma chave deve estar escrita no código.
// Todas vivem exclusivamente nas variáveis do Railway.
// ---------------------------------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_KEY;
const PUBLIC_API_KEY = process.env.PUBLIC_API_KEY;

if (!PUBLIC_API_KEY) {
  console.error('ERRO CRÍTICO: PUBLIC_API_KEY não definida.');
  process.exit(1);
}

if (!ANTHROPIC_API_KEY) {
  console.error('ERRO CRÍTICO: ANTHROPIC_API_KEY não definida.');
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERRO CRÍTICO: SUPABASE_URL ou SUPABASE_KEY não definidas.');
  process.exit(1);
}

// ---------------------------------------------------------------
// CLIENTES — Anthropic e Supabase
// ---------------------------------------------------------------

// Cliente da IA
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Cliente do banco — usa a chave secreta (service_role)
// com acesso total, bypass de RLS — apenas no backend
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------
// MIDDLEWARES GLOBAIS
// ---------------------------------------------------------------

// CORS — permite requisições do frontend Vercel
const ALLOWED_ORIGINS = [
  'https://tekvex-site.vercel.app'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Bloqueado por CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// Parser de JSON — necessário para ler req.body
app.use(express.json());

app.disable('x-powered-by');
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: {
    error: "Muitas requisições. Tente novamente em alguns segundos."
  }
});

// ---------------------------------------------------------------
// SESSÕES EM MEMÓRIA
// Mantém o histórico de conversa por sessionId.
// O Supabase salva o lead — a sessão é só para contexto da IA.
// ---------------------------------------------------------------
const sessions    = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutos

setInterval(() => {
  const now = Date.now();

  for (const [sessionId, session] of sessions.entries()) {
    const expired = now - session.createdAt > SESSION_TTL;

    if (expired) {
      sessions.delete(sessionId);
      console.log(`Sessão removida: ${sessionId}`);
    }
  }
}, 5 * 60 * 1000);

// ---------------------------------------------------------------
// SYSTEM PROMPT — Núcleo da identidade da Vex
// ---------------------------------------------------------------

const SYSTEM_PROMPT = `
Você é a Vex, assistente de clínicas da TekVex AI.

Responda de forma curta, humana e objetiva.

Regras:
- Máximo 2 frases por resposta
- Sempre faça apenas 1 pergunta por vez
- Nunca invente informações médicas
- Se não entender, peça esclarecimento
- Sempre mantenha o foco em agendamento

Fluxo:
- Coletar informações do paciente
- Encaminhar para finalização via WhatsApp

Quando possível, seja natural e simpática.

Não explique o sistema.
Não repita regras.
`;
async function saveLead(sessionId, rawReply) {
  try {
    // Extrai os campos da tag estruturada que a IA inclui na resposta
    const match = rawReply.match(
      /\[LEAD:\s*nome=([^,]+),\s*telefone=([^,]+),\s*especialidade=([^,]+),\s*horario=([^\]]+)\]/
    );

    if (!match) return; // Tag não encontrada — não salva

    const lead = {
      session_id:       sessionId,
      nome:             match[1].trim(),
      telefone:         match[2].trim(),
      especialidade:    match[3].trim(),
      horario_desejado: match[4].trim(),
      status:           'novo',
    };

    // INSERT na tabela leads do Supabase
    const { error } = await supabase.from('leads').insert(lead);

    if (error) {
      console.error('Erro ao salvar lead no Supabase:', error.message);
    } else {
      console.log(`Lead salvo: ${lead.nome} | ${lead.telefone}`);
    }

  } catch (err) {
    // Erro silencioso — não quebra o fluxo do chat
    console.error('Exceção ao salvar lead:', err.message);
  }
}

// ---------------------------------------------------------------
// FUNÇÃO — Salvar mensagem no histórico de conversas
// Registra cada mensagem (user e assistant) na tabela conversations.
// ---------------------------------------------------------------
async function saveMessage(sessionId, role, content) {
  try {
    const { error } = await supabase.from('conversations').insert({
      session_id: sessionId,
      role,
      content,
    });

    if (error) {
      console.error('Erro ao salvar mensagem:', error.message);
    }
  } catch (err) {
    console.error('Exceção ao salvar mensagem:', err.message);
  }
}

// ---------------------------------------------------------------
// ROTA DE SAÚDE — GET /
// Verifica se o servidor está operacional.
// ---------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'TekVex AI Backend' });
});

// ---------------------------------------------------------------
// ROTA PRINCIPAL — POST /chat
// Recebe mensagem, chama a IA, salva no banco e retorna resposta.
// ---------------------------------------------------------------

function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'];

  if (!key || key !== PUBLIC_API_KEY) {
    return res.status(401).json({
      error: 'Não autorizado'
    });
  }

  next();
}

app.post('/chat', authMiddleware, chatLimiter, async (req, res) => {
  const { message, sessionId } = req.body;

  // 1. validação base (ANTES de qualquer trim)
  if (!message || typeof message !== 'string') {
    return res.status(400).json({
      error: 'Campo "message" é obrigatório.'
    });
  }

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({
      error: 'Campo "sessionId" é obrigatório.'
    });
  }

  const trimmedMessage = message.trim();

if (trimmedMessage.length > 500) {
  return res.status(400).json({
    error: "Mensagem muito longa (máx 500 caracteres)"
  });
}


  // --- Recupera ou cria sessão ---
  if (!sessions.has(sessionId)) {
  sessions.set(sessionId, {
    messages: [],
    createdAt: Date.now(),
    state: {
      step: 0,
      nome: null,
      problema: null,
      urgencia: null,
      horario: null
    }
  });
  }
  const session = sessions.get(sessionId);

  session.messages.push({
  role: 'user',
  content: trimmedMessage
});

  // Atualização de estado simples (pipeline básico)
if (!session.state.nome) {
  session.state.step = 1;
}

if (trimmedMessage.length < 30 && session.state.step === 1) {
  session.state.nome = trimmedMessage;
  session.state.step = 2;
}

if (session.state.step === 2 && trimmedMessage.length > 30) {
  session.state.problema = trimmedMessage;
  session.state.step = 3;
}

if (trimmedMessage.includes("urgente") || trimmedMessage.includes("dias")) {
  session.state.urgencia = trimmedMessage;
  session.state.step = 4;
}

if (["manhã", "tarde", "noite"].some(t => trimmedMessage.includes(t))) {
  session.state.horario = trimmedMessage;
  session.state.step = 5;
}

await saveMessage(sessionId, 'user', trimmedMessage);
  
  const stateContext = `
Estado atual do usuário:
- Nome: ${session.state.nome || 'não definido'}
- Problema: ${session.state.problema || 'não definido'}
- Urgência: ${session.state.urgencia || 'não definido'}
- Horário: ${session.state.horario || 'não definido'}
`;
  
  try {
    // --- Chama Claude com histórico completo ---
    const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  system: SYSTEM_PROMPT + stateContext,
  messages: session.messages,
});

    const reply = response.content[0].text;

    const cleanReply = reply.replace(
  /\[LEAD:[^\]]+\]/g,
  ''
).trim();

    // --- Adiciona resposta da IA ao histórico em memória ---
    session.messages.push({ role: 'assistant', content: reply });

    // --- Salva resposta da IA no banco ---
    saveMessage(sessionId, 'assistant', reply);

    // --- Detecta se lead foi coletado e salva no banco ---
    const leadDetected = reply.includes('[LEAD:');
    if (leadDetected) {
      saveLead(sessionId, reply);
    }

    // --- Retorna resposta para o frontend ---
    return res.json({
  reply: cleanReply,
  leadDetected
});

  } catch (error) {
    console.error('Erro ao chamar Anthropic API:', error.message);
    return res.status(502).json({
      error: 'Falha ao processar resposta da IA. Tente novamente.',
    });
  }
});

// ---------------------------------------------------------------
// INICIALIZAÇÃO DO SERVIDOR
// ---------------------------------------------------------------
const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TekVex AI Backend rodando na porta ${PORT}`);
});
