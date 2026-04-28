import express from 'express';

const app = express();

app.get('/', (req, res) => {
  res.send('TekVex AI rodando 🚀');
});

app.listen(3000, () => {
  console.log('Servidor rodando');
});
