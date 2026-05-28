const express = require("express");
const admin = require("firebase-admin");
const twilio = require("twilio");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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

// ── TWILIO INIT ───────────────────────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

const VERIFY_TOKEN = "cliento_webhook_2025";

// ── WEBHOOK VERIFICATION (Meta) ───────────────────────────────────────────────
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

// ── RECEIVE MESSAGES FROM TWILIO ──────────────────────────────────────────────
app.post("/twilio/webhook", async (req, res) => {
  res.status(200).send("OK");

  try {
    const from = req.body.From?.replace("whatsapp:", ""); // ej: +18094868822
    const text = req.body.Body || "";
    const contactName = req.body.ProfileName || "Cliente";
    const timestamp = new Date();

    if (!from || !text) return;

    console.log(`📩 Mensaje de ${from} (${contactName}): ${text}`);

    // ── Buscar workspace con Twilio conectado ─────────────────────────────────
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

    const cleanPhone = from.replace("+", "");
    const customerSnap = await customersRef
      .where("phone", "in", [from, cleanPhone])
      .limit(1)
      .get();

    let customerId;
    let isNewCustomer = false;

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
      isNewCustomer = true;
      console.log(`✅ Nuevo cliente creado: ${contactName} (${from})`);
    } else {
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

    // ── Guardar mensaje en Firebase ───────────────────────────────────────────
    await db.collection("workspaces")
      .doc(workspaceId)
      .collection("messages")
      .add({
        workspaceId,
        customerId,
        text,
        sender: "client",
        timestamp: admin.firestore.Timestamp.fromDate(timestamp),
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    console.log(`✅ Mensaje guardado en Firebase`);

    // ── Mensaje de bienvenida para nuevos clientes ────────────────────────────
    if (isNewCustomer && TWILIO_WHATSAPP_NUMBER) {
      await twilioClient.messages.create({
        from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
        to: `whatsapp:${from}`,
        body: `👋 Hola ${contactName}! Gracias por contactarnos. En breve un agente te atenderá.\n\n_Powered by Cliento_ 🚀`,
      });
      console.log(`✅ Mensaje de bienvenida enviado a ${from}`);
    }

  } catch (error) {
    console.error("❌ Error procesando mensaje:", error);
  }
});

// ── ENVIAR MENSAJE DESDE LA APP ───────────────────────────────────────────────
app.post("/send-message", async (req, res) => {
  try {
    const { to, text, workspaceId, customerId, agentId } = req.body;

    if (!to || !text) {
      return res.status(400).json({ error: "Faltan parámetros: to, text" });
    }

    // Enviar por Twilio WhatsApp
    if (TWILIO_WHATSAPP_NUMBER) {
      const phone = to.startsWith("+") ? to : `+${to}`;
      await twilioClient.messages.create({
        from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
        to: `whatsapp:${phone}`,
        body: text,
      });
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

// ── WEBHOOK META (mantener por si Meta aprueba) ───────────────────────────────
app.post("/webhook", async (req, res) => {
  res.status(200).send("OK");

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    const contacts = body.entry?.[0]?.changes?.[0]?.value?.contacts;
    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const from = message.from;
    const text = message.text?.body || "";
    const contactName = contacts?.[0]?.profile?.name || "Cliente";
    const timestamp = new Date(parseInt(message.timestamp) * 1000);

    console.log(`📩 [Meta] Mensaje de ${from}: ${text}`);

    const workspacesSnap = await db.collection("workspaces")
      .where("isWhatsappConnected", "==", true)
      .get();

    if (workspacesSnap.empty) return;

    const workspaceId = workspacesSnap.docs[0].id;
    const customersRef = db.collection("workspaces")
      .doc(workspaceId)
      .collection("customers");

    const customerSnap = await customersRef
      .where("phone", "==", from)
      .limit(1)
      .get();

    let customerId;

    if (customerSnap.empty) {
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
    } else {
      customerId = customerSnap.docs[0].id;
      const currentUnread = customerSnap.docs[0].data().unreadCount || 0;
      await customersRef.doc(customerId).update({
        lastMessage: text,
        lastMessageAt: admin.firestore.Timestamp.fromDate(timestamp),
        unreadCount: currentUnread + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await db.collection("workspaces")
      .doc(workspaceId)
      .collection("messages")
      .add({
        workspaceId,
        customerId,
        text,
        sender: "client",
        timestamp: admin.firestore.Timestamp.fromDate(timestamp),
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

  } catch (error) {
    console.error("❌ Error [Meta webhook]:", error);
  }
});

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "Cliento Webhook",
    version: "2.1.0",
    firebase: "connected",
    twilio: "connected",
    timestamp: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Cliento Webhook v2.1.0 running on port ${PORT}`);
});