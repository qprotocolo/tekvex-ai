import express from 'express';

const app = express();

// Permitir JSON
app.use(express.json());

// Rota base
app.get('/', (req, res) => {
  res.send('TekVex AI rodando 🚀');
});

// Rota de chat
app.post('/chat', (req, res) => {
  const { message } = req.body;

  console.log('Mensagem recebida:', message);

  res.json({
    reply: 'Recebi sua mensagem. Em breve serei uma IA da TekVex.'
  });
});

// Porta (Railway usa variável de ambiente)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
