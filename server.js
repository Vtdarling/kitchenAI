require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- Configuration ---
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_THIS_TO_A_SUPER_COMPLEX_KEY_IN_ENV";

if (!process.env.GOOGLE_API_KEY) {
  console.error("❌ CRITICAL ERROR: GOOGLE_API_KEY is missing in .env file.");
}

// --- Security Middleware ---
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors()); 
app.use(express.json());
app.use(express.static('public'));

// Rate Limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: "Too many requests from this IP, please try again later."
});
app.use('/api/', apiLimiter);

// --- MongoDB Setup ---
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/chefbot';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => {
      console.error('❌ MongoDB Connection Error:', err.message);
  });

// --- Schemas ---
const UserSchema = new mongoose.Schema({
  name: String,
  phone: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now }
});
const UserModel = mongoose.model('User', UserSchema);

const RequestSchema = new mongoose.Schema({
  userPhone: { type: String, required: true, index: true },
  dishName: String,
  category: { type: String, default: 'Gourmet' },
  recipe: String,
  createdAt: { type: Date, default: Date.now }
});
const RequestModel = mongoose.model('RecipeRequest', RequestSchema);

// --- AI Setup ---
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-09-2025" });

// --- Authentication Middleware ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: "Access Denied" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid Token" });
    req.user = user; 
    next();
  });
};

// --- API Routes ---

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.post('/api/login', async (req, res) => {
    const { name, phone } = req.body;
    
    if (!name || !phone) return res.status(400).json({ error: "Invalid input" });
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: "Phone number must be exactly 10 digits" });

    try {
        let user = await UserModel.findOne({ phone });
        if (!user) {
            user = new UserModel({ name, phone });
            await user.save();
        }

        const token = jwt.sign({ id: user._id, phone: user.phone, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token, user: { name: user.name, phone: user.phone } });
    } catch (error) {
        res.status(500).json({ error: "Login failed" });
    }
});

app.get('/api/history', authenticateToken, async (req, res) => {
  try {
    const history = await RequestModel.find({ userPhone: req.user.phone }).sort({ createdAt: -1 });
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

app.post('/api/get-recipe', authenticateToken, async (req, res) => {
  try {
    const { dish } = req.body;
    if (!dish) return res.status(400).json({ error: "Dish name required" });

    console.log(`[Generating Recipe] For ${dish}...`);

    const prompt = `
    You are a Chef API. The user wants a recipe for: "${dish}".

    STRICT OUTPUT RULES:
    1. Do NOT include any introductory text.
    2. Start IMMEDIATELY with a Markdown Table for Ingredients.
    3. Followed immediately by a Markdown Numbered List for Steps.
    4. Do NOT include a conclusion or outro.
    
    Format Example:
    
    | Ingredient | Quantity |
    |------------|----------|
    | Item 1     | 1 cup    |

    ## Instructions
    1. Step one...
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const recipeText = response.text();

    const newRequest = new RequestModel({
      userPhone: req.user.phone, 
      dishName: dish,
      recipe: recipeText
    });
    await newRequest.save();

    res.json({
      _id: newRequest._id,
      dishName: dish,
      recipe: recipeText, 
      createdAt: newRequest.createdAt
    });

  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ error: "Chef is busy (Server Error)" });
  }
});

app.listen(PORT, () => {
  console.log(`🛡️  Server running on http://localhost:${PORT}`);
});