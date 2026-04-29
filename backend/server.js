// ============================================================
// TEKVEX AI — Backend Principal
// Stack: Node.js + Express + Anthropic Claude + Supabase
// Autor: TekVex Engine
// ============================================================

import express    from 'express';
import cors       from 'cors';
import Anthropic  from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const app = express();

// ---------------------------------------------------------------
// SEGURANÇA — Variáveis de ambiente obrigatórias
// Nenhuma chave deve estar escrita no código.
// Todas vivem exclusivamente nas variáveis do Railway.
// ---------------------------------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_KEY;

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
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// Parser de JSON — necessário para ler req.body
app.use(express.json());

// ---------------------------------------------------------------
// SESSÕES EM MEMÓRIA
// Mantém o histórico de conversa por sessionId.
// O Supabase salva o lead — a sessão é só para contexto da IA.
// ---------------------------------------------------------------
const sessions    = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutos

// ---------------------------------------------------------------
// SYSTEM PROMPT — Núcleo da identidade da Vex
// ---------------------------------------------------------------
const SYSTEM_PROMPT = `
Você é a Vex, assistente de clínicas.

Seu objetivo NÃO é conversar. É converter.

FLUXO OBRIGATÓRIO:
1. Nome
2. Problema
3. Urgência
4. Cidade
5. Confirmação de interesse em agendar

REGRAS:
- Seja direta, humana e firme
- Sempre conduza a próxima pergunta
- Nunca faça perguntas abertas demais
- Nunca perca controle da conversa

Após coletar tudo:

Diga:

"Perfeito, já tenho tudo que preciso. Vou te encaminhar agora para finalizar seu agendamento com a equipe da clínica. É bem rápido."

IMPORTANTE:
- Só liberar o WhatsApp após confirmação clara
- Se houver dúvida, trate antes de avançar
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
app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  // --- Validação de entrada ---
  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: 'Campo "message" é obrigatório.' });
  }

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Campo "sessionId" é obrigatório.' });
  }

  // --- Recupera ou cria sessão ---
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { messages: [], createdAt: Date.now() });
  }

  const session = sessions.get(sessionId);

  // --- Bloqueia sessões expiradas ---
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(sessionId);
    return res.status(410).json({ error: 'Sessão expirada. Recarregue o chat.' });
  }

  // --- Adiciona mensagem do usuário ao histórico em memória ---
  session.messages.push({ role: 'user', content: message.trim() });

  // --- Salva mensagem do usuário no banco (não bloqueia resposta) ---
  saveMessage(sessionId, 'user', message.trim());

  try {
    // --- Chama Claude com histórico completo ---
    const response = await anthropic.messages.create({
      model:    'claude-sonnet-4-5',
      max_tokens: 1024,
      system:   SYSTEM_PROMPT,
      messages: session.messages,
    });

    const reply = response.content[0].text;

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
    return res.json({ reply, leadDetected });

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
