
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const http=require('http');
const socketIO = require('socket.io');
const mongoose = require("mongoose");
const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { SigningCosmWasmClient } = require("@cosmjs/cosmwasm-stargate");
const { SigningStargateClient, GasPrice } = require("@cosmjs/stargate");
const morgan = require("morgan");
const { analyticsLogger } = require("./middleware/analytics");
const { winstonLogger } = require("./middleware/logger");

const app = express();
app.use(morgan("combined", { stream: winstonLogger.stream }));
app.use(analyticsLogger);

app.use(bodyParser.json());
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
// ====== DB Connection ======
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => winstonLogger.info("MongoDB connected"))
  .catch(err => winstonLogger.error("MongoDB connection error", err));;
const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.once("open", () => {
  console.log("✅ Connected to MongoDB Atlas");
})

// ====== MongoDB User Schema ======
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  meta_account: { type: String, required: true, unique: true },
  xion_address: { type: String, required: true, unique: true },
  mnemonic: { type: String, required: true },
});
const User = mongoose.model("User", userSchema);

// ====== MongoDB Group Schema ======
const memberSchema = new mongoose.Schema({
  xion_address: { type: String, required: true },
  role: { type: String, enum: ["member", "admin"], default: "member" },
});

const groupSchema = new mongoose.Schema({
  group_name: { type: String, required: true, unique: true },
  creator_address: { type: String, required: true },
  members: [memberSchema],
  created_at: { type: Date, default: Date.now },
});


const messageSchema = new mongoose.Schema({
  from: String,
  to: String,
  message: String,
  timestamp: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);

const Group = mongoose.model("Group", groupSchema);

// ====== Xion Setup ======
const RPC_ENDPOINT = 'https://rpc.xion-testnet-2.burnt.com:443';
const contractAddress = "xion10j9azs653rf87szgadmwrwxahzy7w3sjldslsv20yjqtrgcdrjqskemp86";
const chainPrefix = "xion";
const GAS_PRICE = "0.025uxion";
const GAS_ADJUSTMENT = 1.5;

const FAUCET_MNEMONIC = process.env.FAUCET_MNEMONIC;
if (!FAUCET_MNEMONIC || FAUCET_MNEMONIC.split(" ").length < 12) {
  console.error("❌ Invalid or missing FAUCET_MNEMONIC in .env");
  process.exit(1);
}

// ====== FUND ACCOUNT ======
async function fundNewAccount(recipientAddress) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(FAUCET_MNEMONIC, { prefix: chainPrefix });
  const [faucetAccount] = await wallet.getAccounts();

  const client = await SigningStargateClient.connectWithSigner(RPC_ENDPOINT, wallet, {
    gasPrice: GasPrice.fromString(GAS_PRICE),
    gasAdjustment: GAS_ADJUSTMENT,
  });

  const amount = {
    denom: "uxion",
    amount: "200000",
  };

  const result = await client.sendTokens(
    faucetAccount.address,
    recipientAddress,
    [amount],
    "auto",
    "Initial funding"
  );

  if (result.code) {
    throw new Error(`Funding tx failed with code ${result.code}: ${result.rawLog}`);
  }

  return result;
}

// ====== WAIT FOR ACCOUNT ======
async function waitForAccount(client, address, timeout = 30000, interval = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const account = await client.getAccount(address);
      if (account) return true;
    } catch (err) {}
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timeout waiting for account ${address} to appear on chain`);
}

// ====== REGISTER ROUTE ======
app.post("/register", async (req, res) => {
  try {
    const { username, meta_account } = req.body;

    if (!username || !meta_account) {
      return res.status(400).json({ error: "username and meta_account are required" });
    }

    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(409).json({ error: "Username already taken" });
    }

    const existingMeta = await User.findOne({ meta_account });
    if (existingMeta) {
      return res.status(409).json({
        error: "Meta account already registered",
        address: existingMeta.xion_address,
      });
    }

    const wallet = await DirectSecp256k1HdWallet.generate(12, { prefix: chainPrefix });
    const [account] = await wallet.getAccounts();
    const newMetaAccount = account.address;
    const mnemonic = wallet.mnemonic;

    await fundNewAccount(newMetaAccount);

    const checkClient = await SigningStargateClient.connect(RPC_ENDPOINT);
    await waitForAccount(checkClient, newMetaAccount);

    const client = await SigningCosmWasmClient.connectWithSigner(RPC_ENDPOINT, wallet, {
      gasPrice: GasPrice.fromString(GAS_PRICE),
      gasAdjustment: GAS_ADJUSTMENT,
    });

    await client.execute(
      account.address,
      contractAddress,
      {
        RegisterUser: {
          username,
          address: newMetaAccount,
        },
      },
      "auto"
    );

    const user = new User({
      username,
      meta_account,
      xion_address: newMetaAccount,
      mnemonic,
    });
    await user.save();

    res.status(200).json({
      message: "User registered successfully",
      address: newMetaAccount,
    });
  } catch (error) {
    console.error("Registration failed:", error);
    res.status(500).json({
      error: "Registration failed",
      details: error.message,
    });
  }
});

// ====== LOGIN ROUTE ======
app.post("/login", async (req, res) => {
  try {
    const { username, meta_account } = req.body;

    if (!username || !meta_account) {
      return res.status(400).json({ error: "Both username and meta_account are required" });
    }

    const user = await User.findOne({ username, meta_account });

    if (!user) {
      return res.status(404).json({ error: "Invalid username or meta_account" });
    }

    const client = await SigningStargateClient.connect(RPC_ENDPOINT);
    const account = await client.getAccount(user.xion_address);

    if (!account) {
      return res.status(404).json({ error: "On-chain account not found" });
    }

    res.status(200).json({
      message: "Login successful",
      username: user.username,
      meta_account: user.meta_account,
      xion_address: user.xion_address
    });

  } catch (error) {
    console.error("Login failed:", error);
    res.status(500).json({
      error: "Login failed",
      details: error.message,
    });
  }
});

// ====== CREATE GROUP ======
app.post("/create-group", async (req, res) => {
  try {
    const { group_name, creator_mnemonic } = req.body;

    if (!group_name || !creator_mnemonic) {
      return res.status(400).json({ error: "group_name and creator_mnemonic are required" });
    }

    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(creator_mnemonic, { prefix: chainPrefix });
    const [account] = await wallet.getAccounts();

    const client = await SigningCosmWasmClient.connectWithSigner(RPC_ENDPOINT, wallet, {
      gasPrice: GasPrice.fromString(GAS_PRICE),
      gasAdjustment: GAS_ADJUSTMENT,
    });

    await client.execute(
      account.address,
      contractAddress,
      {
        CreateGroup: {
          name: group_name,
        },
      },
      "auto"
    );

    // Save group in DB with creator as admin member
    const group = new Group({
      group_name,
      creator_address: account.address,
      members: [{ xion_address: account.address, role: "admin" }],
    });
    await group.save();

    res.status(200).json({ message: "Group created successfully", group });
  } catch (error) {
    console.error("Group creation failed:", error);
    res.status(500).json({
      error: "Group creation failed",
      details: error.message,
    });
  }
});


// ====== GET ALL MEMBERS OF A GROUP ======
app.get("/group/:groupName/members", async (req, res) => {
  try {
    const { groupName } = req.params;

    const group = await Group.findOne({ group_name: groupName });
    if (!group) return res.status(404).json({ error: "Group not found" });

    res.status(200).json({ members: group.members });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to retrieve group members" });
  }
});


// ====== ADD MEMBER ======
app.post("/group/:groupName/add-member", async (req, res) => {
  try {
    const groupName = req.params.groupName.trim();
   

// console.log("Group result:", group);


    const { meta_account } = req.body;
    if (!meta_account) return res.status(400).json({ error: "meta_account is required" });

    const user = await User.findOne({ meta_account });
    if (!user) return res.status(404).json({ error: "User with that meta_account not found" });

    const group = await Group.findOne({ group_name: groupName });
    if (!group) return res.status(404).json({ error: "Group not found" });



    if (group.members.some(m => m.xion_address === user.xion_address)) {
      return res.status(409).json({ error: "Member already exists" });
    }

    group.members.push({ xion_address: user.xion_address, role: "member" });
    await group.save();

    res.status(200).json({ message: "Member added successfully", members: group.members });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to add member" });
  }
});

// ====== REMOVE MEMBER ======
// app.post("/group/:groupName/remove-member", async (req, res) => {
//   try {
//     const groupName = req.params.groupName.trim();
//     const { meta_account } = req.body;
//     if (!meta_account) return res.status(400).json({ error: "meta_account is required" });

//     const user = await User.findOne({ meta_account });
//     if (!user) return res.status(404).json({ error: "User with that meta_account not found" });

//     const group = await Group.findOne({ group_name: groupName });
//     if (!group) return res.status(404).json({ error: "Group not found" });

//     const beforeCount = group.members.length;
//     group.members = group.members.filter(m => m.xion_address !== user.xion_address);

//     if (group.members.length === beforeCount) {
//       return res.status(404).json({ error: "Member not found in group" });
//     }

//     await group.save();
//     res.status(200).json({ message: "Member removed successfully", members: group.members });
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ error: "Failed to remove member" });
//   }
// });

// ====== PROMOTE MEMBER TO ADMIN ======
app.post("/group/:groupName/promote-member", async (req, res) => {
  try {
    const groupName = req.params.groupName.trim();
    const { meta_account } = req.body;
    if (!meta_account) return res.status(400).json({ error: "meta_account is required" });

    const user = await User.findOne({ meta_account });
    if (!user) return res.status(404).json({ error: "User with that meta_account not found" });

    const group = await Group.findOne({ group_name: groupName });
    if (!group) return res.status(404).json({ error: "Group not found" });

    const member = group.members.find(m => m.xion_address === user.xion_address);
    if (!member) return res.status(404).json({ error: "Member not found" });

    member.role = "admin";
    await group.save();

    res.status(200).json({ message: "Member promoted to admin", members: group.members });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to promote member" });
  }
});

// ====== GET ALL USER GROUP ======
app.get("/user/:xion_address/groups", async (req, res) => {
  try {
    const { xion_address } = req.params;
    const groups = await Group.find({ "members.xion_address": xion_address });
    res.status(200).json({ groups });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch user's groups" });
  }
});



// ====== DELETE GROUP ======
app.delete("/group/:groupName", async (req, res) => {
  try {
    const { groupName } = req.params;
    const { meta_account } = req.body;

    if (!meta_account) {
      return res.status(400).json({ error: "meta_account is required" });
    }

    const user = await User.findOne({ meta_account });
    if (!user) return res.status(404).json({ error: "User not found" });

    const group = await Group.findOne({ group_name: groupName });
    if (!group) return res.status(404).json({ error: "Group not found" });

    // Only allow creator or admin to delete the group
    const isAdminOrCreator =
      group.creator_address === user.xion_address ||
      group.members.some(m => m.xion_address === user.xion_address && m.role === "admin");

    if (!isAdminOrCreator) {
      return res.status(403).json({ error: "You do not have permission to delete this group" });
    }

    await Group.deleteOne({ _id: group._id });

    res.status(200).json({ message: "Group deleted successfully" });
  } catch (error) {
    console.error("Failed to delete group:", error);
    res.status(500).json({ error: "Failed to delete group", details: error.message });
  }
});




app.post("/send-group-message", async (req, res) => {
  try {
    const { group_name, sender_mnemonic, message } = req.body;

    if (!group_name || !sender_mnemonic || !message) {
      return res.status(400).json({ error: "group_name, sender_mnemonic, and message are required" });
    }

    // Load sender wallet from mnemonic
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(sender_mnemonic, { prefix: chainPrefix });
    const [account] = await wallet.getAccounts();

    // Find group in DB exactly as passed
    const group = await Group.findOne({ group_name: group_name });

    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }

    // Find user by xion_address
    const user = await User.findOne({ xion_address: account.address });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if user is a member of the group
    const isMember = group.members.some(member => member.xion_address === user.xion_address);

    if (!isMember) {
      return res.status(403).json({ error: "User is not a member of this group" });
    }

    // Connect client with signer
    const client = await SigningCosmWasmClient.connectWithSigner(RPC_ENDPOINT, wallet, {
      gasPrice: GasPrice.fromString(GAS_PRICE),
      gasAdjustment: GAS_ADJUSTMENT,
    });

    // Execute SendGroupMessage on-chain
    const executeMsg = {
      PostGroupMessage: {
        group: group_name,
        content: message,
      },
    };

    const result = await client.execute(
      account.address,
      contractAddress,
      executeMsg,
      "auto"
    );

    if (result.code) {
      return res.status(500).json({ error: `Transaction failed with code ${result.code}: ${result.rawLog}` });
    }

    res.status(200).json({ message: "Group message sent on-chain successfully", txHash: result.transactionHash });

  } catch (error) {
    console.error("Failed to send group message:", error);
    res.status(500).json({ error: "Failed to send group message", details: error.message });
  }
});


app.get("/group/:groupName/messages", async (req, res) => {
  try {
    const { groupName } = req.params;

    // Query structure matches the smart contract query
    const executeMsg = {
      GetGroup: {
        name: groupName,
      },
    };
const { CosmWasmClient } = require("@cosmjs/cosmwasm-stargate");

    const client = await CosmWasmClient.connect(RPC_ENDPOINT);

    const messages = await client.queryContractSmart(contractAddress, executeMsg);

    if (!messages || messages.length === 0) {
      return res.status(404).json({ error: "No messages found for this group" });
    }

    res.status(200).json({
      group: groupName,
      messages,
    });

  } catch (error) {
    console.error("Error getting group messages:", error);
    res.status(500).json({ error: "Failed to fetch group messages", details: error.message });
  }
});

app.post("/me", async (req, res) => {
  try {
    const { meta_account } = req.body;

    if (!meta_account) {
      return res.status(400).json({ error: "meta_account is required" });
    }

    const user = await User.findOne({ meta_account });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.status(200).json({
      username: user.username,
      meta_account: user.meta_account,
      xion_address: user.xion_address,
     mnemonic:user.mnemonic
    });
  } catch (error) {
    console.error("Failed to fetch user details:", error);
    res.status(500).json({
      error: "Failed to retrieve user",
      details: error.message,
    });
  }
});


app.get("/group-messages/:group", async (req, res) => {
  try {
    const { group } = req.params;

    if (!group) {
      return res.status(400).json({ error: "Group name is required" });
    }

    const { CosmWasmClient } = require("@cosmjs/cosmwasm-stargate");
    const client = await CosmWasmClient.connect(RPC_ENDPOINT);

    const query = {
      GetMessages: {     // this must match the smart contract's query name
        group,
      },
    };

    const result = await client.queryContractSmart(contractAddress, query);

    res.status(200).json({ messages: result || [] });
  } catch (error) {
    console.error("Failed to fetch group messages:", error);
    res.status(500).json({
      error: "Failed to fetch group messages",
      details: error.message
    });
  }
});

const xionSocketMap = {};

io.on('connection', socket => {
  console.log('New client connected:', socket.id);

  // Register the user's Xion ID
  socket.on('registerXionId', xionId => {
    xionSocketMap[xionId] = socket.id;
    console.log(`${xionId} registered with socket ${socket.id}`);
  });

  // Handle sending a message
  socket.on('sendMessage', async data => {
    const { from, to, message } = data;

    // Save message in MongoDB
    const newMessage = new Message({ from, to, message });
    await newMessage.save();

    const recipientSocketId = xionSocketMap[to];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('receiveMessage', {
        from,
        message,
        timestamp: newMessage.timestamp
      });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    for (const xionId in xionSocketMap) {
      if (xionSocketMap[xionId] === socket.id) {
        delete xionSocketMap[xionId];
        break;
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

// Route to get all messages between two users
app.get('/messages/:user1/:user2', async (req, res) => {
  const { user1, user2 } = req.params;

  try {
    const messages = await Message.find({
      $or: [
        { from: user1, to: user2 },
        { from: user2, to: user1 }
      ]
    }).sort({ timestamp: 1 });

    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
})

const PORT=process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
