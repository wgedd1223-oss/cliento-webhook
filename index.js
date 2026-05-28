const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// ── FIREBASE INIT ─────────────────────────────────────────────────────────────
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: privateKey,
  }),
});

const db = admin.firestore();

const VERIFY_TOKEN = "cliento_webhook_2025";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ── WEBHOOK VERIFICATION ──────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified!");
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Forbidden");
});

// ── RECEIVE MESSAGES ─────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.status(200).send("OK"); // Responder rápido a Meta

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    const contacts = value?.contacts;

    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const from = message.from; // número del cliente ej: 18094868822
    const text = message.text?.body || "";
    const timestamp = new Date(parseInt(message.timestamp) * 1000);
    const contactName = contacts?.[0]?.profile?.name || "Cliente";
    const messageId = message.id;

    console.log(`📩 Mensaje de ${from} (${contactName}): ${text}`);

    // ── Buscar workspace por número de teléfono ───────────────────────────────
    const workspacesSnap = await db.collection("workspaces")
      .where("isWhatsappConnected", "==", true)
      .get();

    if (workspacesSnap.empty) {
      console.log("⚠️ No hay workspaces con WhatsApp conectado");
      return;
    }

    const workspace = workspacesSnap.docs[0];
    const workspaceId = workspace.id;

    // ── Buscar o crear cliente ────────────────────────────────────────────────
    const customersRef = db.collection("workspaces")
      .doc(workspaceId)
      .collection("customers");

    const customerSnap = await customersRef
      .where("phone", "==", from)
      .limit(1)
      .get();

    let customerId;

    if (customerSnap.empty) {
      // Crear nuevo cliente
      const newCustomer = await customersRef.add({
        workspaceId,
        name: contactName,
        phone: from,
        label: "nuevo",
        unreadCount: 1,
        lastMessage: text,
        lastMessageAt: admin.firestore.Timestamp.fromDate(timestamp),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      customerId = newCustomer.id;
      console.log(`✅ Nuevo cliente creado: ${contactName} (${from})`);
    } else {
      // Actualizar cliente existente
      const customerDoc = customerSnap.docs[0];
      customerId = customerDoc.id;
      const currentUnread = customerDoc.data().unreadCount || 0;

      await customersRef.doc(customerId).update({
        lastMessage: text,
        lastMessageAt: admin.firestore.Timestamp.fromDate(timestamp),
        unreadCount: currentUnread + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`✅ Cliente actualizado: ${contactName}`);
    }

    // ── Guardar mensaje ───────────────────────────────────────────────────────
    const messagesRef = db.collection("workspaces")
      .doc(workspaceId)
      .collection("messages");

    // Verificar que no sea duplicado
    const existingMsg = await messagesRef
      .where("whatsappMessageId", "==", messageId)
      .limit(1)
      .get();

    if (!existingMsg.empty) {
      console.log("⚠️ Mensaje duplicado, ignorando");
      return;
    }

    await messagesRef.add({
      workspaceId,
      customerId,
      text,
      sender: "client",
      whatsappMessageId: messageId,
      timestamp: admin.firestore.Timestamp.fromDate(timestamp),
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Mensaje guardado en Firebase: "${text}"`);

    // ── Menú de bienvenida (solo para nuevos clientes) ────────────────────────
    if (customerSnap.empty && WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
      await sendWelcomeMessage(from, contactName);
    }

  } catch (error) {
    console.error("❌ Error procesando mensaje:", error);
  }
});

// ── ENVIAR MENSAJE DE BIENVENIDA ──────────────────────────────────────────────
async function sendWelcomeMessage(to, name) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: {
            body: `👋 Hola ${name}! Gracias por contactarnos. En breve un agente te atenderá.\n\n_Powered by Cliento_ 🚀`,
          },
        }),
      }
    );
    const data = await response.json();
    console.log("✅ Mensaje de bienvenida enviado:", data);
  } catch (error) {
    console.error("❌ Error enviando bienvenida:", error);
  }
}

// ── ENVIAR MENSAJE DESDE LA APP ───────────────────────────────────────────────
app.post("/send-message", async (req, res) => {
  try {
    const { to, text, workspaceId, customerId, agentId } = req.body;

    if (!to || !text) {
      return res.status(400).json({ error: "Faltan parámetros: to, text" });
    }

    // Enviar por WhatsApp API
    if (WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
      const response = await fetch(
        `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to,
            type: "text",
            text: { body: text },
          }),
        }
      );
      const data = await response.json();
      if (data.error) {
        return res.status(400).json({ error: data.error });
      }
    }

    // Guardar en Firebase
    if (workspaceId && customerId) {
      await db.collection("workspaces")
        .doc(workspaceId)
        .collection("messages")
        .add({
          workspaceId,
          customerId,
          text,
          sender: "agent",
          agentId: agentId || null,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          isRead: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      await db.collection("workspaces")
        .doc(workspaceId)
        .collection("customers")
        .doc(customerId)
        .update({
          lastMessage: text,
          lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("❌ Error enviando mensaje:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "Cliento Webhook",
    version: "2.0.0",
    firebase: "connected",
    timestamp: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Cliento Webhook v2.0.0 running on port ${PORT}`);
});