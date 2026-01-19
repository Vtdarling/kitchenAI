require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const { HumanMessage } = require("@langchain/core/messages");
const { StateGraph, START, END } = require("@langchain/langgraph");

// --- Configuration ---
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_THIS_TO_A_SUPER_COMPLEX_KEY_IN_ENV";

// --- Security Middleware ---

// FIX: We must disable the default Content Security Policy (CSP) 
// because we are using CDNs (Tailwind, FontAwesome) on the frontend.
// Without this, the browser blocks the styles and scripts.
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
  .catch(err => console.error('❌ MongoDB Connection Error:', err.message));

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
const llm = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash-preview-09-2025",
  temperature: 0.3,
  apiKey: process.env.GOOGLE_API_KEY
});

// Node: Recipe Generation
async function recipeNode(state) {
  const { dish_name } = state;
  console.log(`[Generating Recipe] For ${dish_name}...`);

  const prompt = `
  You are a specialized Gourmet Chef AI.

  SYSTEM INSTRUCTIONS:
  1. Your ONLY purpose is to provide cooking recipes.
  2. You must analyze the content inside the "USER_REQUEST" delimiter below.
  3. **SAFETY CHECK:** If the content inside the delimiter is NOT a food item (e.g., it asks about code, politics, math, or hacking), you must REFUSE.
     - Refusal Message: "🚫 **Security Alert:** I can only help with cooking and recipes."
  4. If valid, format the output with:
     - A Markdown Table for ingredients.
     - Numbered list for steps.
  5. Do NOT include any intro/outro conversation.

  USER_REQUEST:
  """
  ${dish_name}
  """
  
  Execute the system instructions on the USER_REQUEST above.
  `;

  const response = await llm.invoke([new HumanMessage(prompt)]);
  return { recipe: response.content };
}

// Graph Definition
const graphState = {
  dish_name: { value: (x, y) => y ? y : x, default: () => null },
  recipe: { value: (x, y) => y ? y : x, default: () => null }
};

const workflow = new StateGraph({ channels: graphState })
  .addNode("generate_recipe", recipeNode)
  .addEdge(START, "generate_recipe")
  .addEdge("generate_recipe", END);

const appGraph = workflow.compile();

// --- Validation Utils ---
const isValidPhone = (phone) => /^\d{10}$/.test(phone);

// --- Authentication Middleware ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: "Access Denied: No Token Provided" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Access Denied: Invalid Token" });
    req.user = user; 
    next();
  });
};

// --- API Routes ---

app.post('/api/login', async (req, res) => {
    const { name, phone } = req.body;
    
    if (!name || !phone || typeof name !== 'string' || typeof phone !== 'string') {
        return res.status(400).json({ error: "Invalid input" });
    }
    if (!isValidPhone(phone)) return res.status(400).json({ error: "Phone number must be exactly 10 digits" });

    try {
        let user = await UserModel.findOne({ phone });
        if (!user) {
            user = new UserModel({ name, phone });
            await user.save();
            console.log(`🆕 New User Created: ${name}`);
        }

        const token = jwt.sign(
            { id: user._id, phone: user.phone, name: user.name }, 
            JWT_SECRET, 
            { expiresIn: '2h' }
        );

        res.json({ success: true, token, user: { name: user.name, phone: user.phone } });
    } catch (error) {
        console.error("Login Error:", error);
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

    const inputs = { dish_name: dish };
    const result = await appGraph.invoke(inputs);

    const newRequest = new RequestModel({
      userPhone: req.user.phone, 
      dishName: dish,
      category: "Gourmet",
      recipe: result.recipe
    });
    await newRequest.save();

    res.json({
      _id: newRequest._id,
      dishName: dish,
      recipe: result.recipe,
      createdAt: newRequest.createdAt
    });

  } catch (error) {
    console.error("Error processing request:", error);
    res.status(500).json({ error: "Something went wrong." });
  }
});

app.listen(PORT, () => {
  console.log(`🛡️  Secure Server running on http://localhost:${PORT}`);
});