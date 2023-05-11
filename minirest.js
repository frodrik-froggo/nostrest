const express = require('express')

const app = express();

app.get('/whodis', (req,res) => {
  console.log('Got a request from', req.hostname);
  res.status(200).send('It\'se Mario!');
})

app.listen(3338, '0.0.0.0', () => {
  console.log( 'minirest listening on http://localhost:3338');
});