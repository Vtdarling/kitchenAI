require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const { HumanMessage } = require("@langchain/core/messages");
// FIX: Import 'START' constant
const { StateGraph, START, END } = require("@langchain/langgraph");

// --- Configuration ---
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve the HTML file

// --- MongoDB Setup ---
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/chefbot';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
    if (err.code === 8000 || err.message.includes('bad auth')) {
        console.error('\n⚠️  AUTHENTICATION FAILED');
        console.error('   -> Check the username and password in your .env file.');
        console.error('   -> CRITICAL: If your password has special characters (e.g., @, !, #), you MUST URL-encode them.\n');
    }
  });

// Define Schema for Chat History
const RequestSchema = new mongoose.Schema({
  dishName: String,
  category: String,
  recipe: String,
  createdAt: { type: Date, default: Date.now }
});
const RequestModel = mongoose.model('RecipeRequest', RequestSchema);

// --- AI & LangGraph Setup ---

// 1. Initialize Gemini
const llm = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash-preview-09-2025", 
  temperature: 0.3, 
  apiKey: process.env.GOOGLE_API_KEY
});

// 2. Define Nodes

// Node 2: Categorization
async function categorizationNode(state) {
  const dish = state.dish_name;
  console.log(`[Categorizing] ${dish}...`);

  const prompt = `Categorize the dish '${dish}' into exactly one of these categories: Veg, Non-Veg, Fast Food, Drinks. Return ONLY the category name.`;
  
  const response = await llm.invoke([new HumanMessage(prompt)]);
  return { category: response.content.trim() };
}

// Node 3: Recipe Generation
async function recipeNode(state) {
  const { dish_name, category } = state;
  console.log(`[Generating Recipe] For ${dish_name} (${category})...`);

  // UPDATED PROMPT: Requesting Simple English & Table
  const prompt = `The user wants to make '${dish_name}' (${category}).
  
  Please follow these strict formatting rules:
  1. **Language**: Use VERY SIMPLE English. Short sentences. No hard words.
  2. **Ingredients**: Provide them in a Markdown Table with two columns: "Ingredient" and "Quantity".
  3. **Procedure**: Provide the steps as a numbered list. 
     - Bold the main action verbs (e.g., **Mix**, **Boil**, **Cut**).
     - Keep steps short and easy to read.

  Do not include any intro or outro text. Just the table and the steps.`;
  
  const response = await llm.invoke([new HumanMessage(prompt)]);
  return { recipe: response.content };
}

// 3. Build the Graph
const graphState = {
  dish_name: { value: (x, y) => y ? y : x, default: () => null },
  category: { value: (x, y) => y ? y : x, default: () => null },
  recipe: { value: (x, y) => y ? y : x, default: () => null }
};

const workflow = new StateGraph({ channels: graphState })
  .addNode("categorize", categorizationNode)
  .addNode("generate_recipe", recipeNode)
  .addEdge(START, "categorize") 
  .addEdge("categorize", "generate_recipe") 
  .addEdge("generate_recipe", END); 

const appGraph = workflow.compile();

// --- API Routes ---

app.post('/api/get-recipe', async (req, res) => {
  try {
    const { dish } = req.body;
    if (!dish) return res.status(400).json({ error: "Dish name is required" });

    // 1. Run the LangGraph Workflow
    const inputs = { dish_name: dish };
    const result = await appGraph.invoke(inputs);

    // 2. Save to MongoDB
    const newRequest = new RequestModel({
      dishName: result.dish_name,
      category: result.category,
      recipe: result.recipe
    });
    await newRequest.save();

    // 3. Send Response
    res.json({
      category: result.category,
      recipe: result.recipe
    });

  } catch (error) {
    console.error("Error processing request:", error);
    res.status(500).json({ error: "Something went wrong. Check server console." });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const history = await RequestModel.find().sort({ createdAt: -1 }).limit(10);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

app.listen(PORT, () => {
  console.log(`👨‍🍳 Server running on http://localhost:${PORT}`);
});