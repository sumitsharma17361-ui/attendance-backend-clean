const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const MONGO_URI = process.env.MONGO_URI;

if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('SUCCESS: MongoDB Connected Successfully!'))
    .catch(err => console.log('DB CONNECTION ERROR:', err.message));
} else {
  console.log('MONGO_URI missing!');
}

app.get('/', (req, res) => {
  res.send('Backend Server is Live & Clean!');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
