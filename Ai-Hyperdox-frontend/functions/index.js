const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp }      = require("firebase-admin/app");
const { getAuth }            = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { defineSecret }       = require("firebase-functions/params");

initializeApp();

const db = getFirestore();

// ── Stripe secret stored securely in Firebase Secret Manager ──────────────
const stripeSecret = defineSecret("STRIPE_SECRET_KEY");

const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwYf4q9lVrZsYJjww1YFRdVHaLKzednAB02ftxMYS826BC_CYoA6dyWKqmf0YnKcEk/exec";

async function callGAS(payload) {
  const res = await fetch(GAS_URL, {
    method:  "POST",
    headers: { "Content-Type": "text/plain" },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`GAS responded with ${res.status}`);
}

// ════════════════════════════════════════════════════════════════
//  EMAIL FUNCTIONS (unchanged)
// ════════════════════════════════════════════════════════════════

exports.sendVerificationEmail = onCall(
  { cors: true, invoker: "public" },
  async (request) => {
    const { uid, name } = request.data;
    if (!uid) throw new HttpsError("invalid-argument", "uid is required");

    const user = await getAuth().getUser(uid);
    if (user.emailVerified) return { success: true, message: "Already verified" };

    const link = await getAuth().generateEmailVerificationLink(user.email);
    await callGAS({ type: "verification", email: user.email, link, name: name || "" });

    return { success: true };
  }
);

exports.sendPasswordResetEmail = onCall(
  { cors: true, invoker: "public" },
  async (request) => {
    const { email, name } = request.data;
    if (!email) throw new HttpsError("invalid-argument", "email is required");

    const link = await getAuth().generatePasswordResetLink(email);
    await callGAS({ type: "reset", email, link, name: name || "" });

    return { success: true };
  }
);

// ════════════════════════════════════════════════════════════════
//  BILLING — savePaymentMethod
//  Saves a Stripe card to the user's Firestore doc.
//  Called from the BillingSettings page when a user adds/changes card.
// ════════════════════════════════════════════════════════════════

exports.savePaymentMethod = onCall(
  { cors: true, invoker: "public", secrets: [stripeSecret] },
  async (request) => {
    // Must be signed in
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const { paymentMethodId } = request.data;
    if (!paymentMethodId) {
      throw new HttpsError("invalid-argument", "paymentMethodId is required");
    }

    const stripe = require("stripe")(stripeSecret.value());
    const uid    = request.auth.uid;

    // Read existing user doc
    const userRef  = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError("not-found", "User document not found.");
    }
    const userData = userSnap.data();

    // Create Stripe customer if this is the first card
    let customerId = userData.stripeCustomerId || null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    userData.email  || request.auth.token.email,
        name:     userData.fullName || "",
        metadata: { firebaseUid: uid },
      });
      customerId = customer.id;
    }

    // Attach payment method to Stripe customer
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });

    // Set as default payment method
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // Retrieve last 4 digits and card brand for display
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    const last4 = pm.card.last4;
    const brand = pm.card.brand; // "visa", "mastercard", etc.

    // Save to Firestore
    await userRef.update({
      stripeCustomerId:        customerId,
      defaultPaymentMethodId:  paymentMethodId,
      cardLast4:               last4,
      cardBrand:               brand,
    });

    return { success: true, last4, brand };
  }
);

// ════════════════════════════════════════════════════════════════
//  BILLING — initiateRun
//  Called BEFORE each document generation run.
//  Uses a free run if available; otherwise charges $10 via Stripe.
// ════════════════════════════════════════════════════════════════

exports.initiateRun = onCall(
  { cors: true, invoker: "public", secrets: [stripeSecret] },
  async (request) => {
    // Must be signed in
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const { projectId, docType } = request.data;
    if (!projectId || !docType) {
      throw new HttpsError("invalid-argument", "projectId and docType are required");
    }

    const stripe  = require("stripe")(stripeSecret.value());
    const uid     = request.auth.uid;
    const userRef = db.collection("users").doc(uid);

    // Use a Firestore transaction to safely decrement free runs
    const result = await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists) {
        throw new HttpsError("not-found", "User document not found.");
      }

      const userData        = userSnap.data();
      const freeRuns        = userData.freeRunsRemaining ?? 0;
      const customerId      = userData.stripeCustomerId  || null;
      const paymentMethodId = userData.defaultPaymentMethodId || null;

      // ── Option A: use a free run ──────────────────────────────
      if (freeRuns > 0) {
        transaction.update(userRef, {
          freeRunsRemaining: FieldValue.increment(-1),
          totalRunsUsed:     FieldValue.increment(1),
        });
        return { status: "free", freeRunsRemaining: freeRuns - 1 };
      }

      // ── Option B: charge card ─────────────────────────────────
      if (!customerId || !paymentMethodId) {
        throw new HttpsError(
          "failed-precondition",
          "No payment method on file. Please add a card in Billing Settings."
        );
      }

      // Return customer/payment info so we can charge outside the transaction
      return {
        status:          "charge_needed",
        customerId,
        paymentMethodId,
        userData,
      };
    });

    // If free run was used, log it and return
    if (result.status === "free") {
      await db.collection("runs").add({
        userId:    uid,
        projectId,
        docType,
        amount:    0,
        status:    "free",
        createdAt: FieldValue.serverTimestamp(),
      });
      return { success: true, status: "free", freeRunsRemaining: result.freeRunsRemaining };
    }

    // Charge $10 via Stripe (off-session = card on file, no redirect needed)
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount:               1000, // $10.00 in cents
        currency:             "usd",
        customer:             result.customerId,
        payment_method:       result.paymentMethodId,
        confirm:              true,
        off_session:          true,
        description:          `AI Hyperdox run — ${docType}`,
        metadata:             { firebaseUid: uid, projectId, docType },
      });
    } catch (stripeError) {
      // Card declined or authentication required
      throw new HttpsError(
        "failed-precondition",
        stripeError.message || "Payment failed. Please update your card."
      );
    }

    // Log the paid run
    await db.collection("runs").add({
      userId:               uid,
      projectId,
      docType,
      amount:               1000,
      status:               "paid",
      stripePaymentIntentId: paymentIntent.id,
      createdAt:            FieldValue.serverTimestamp(),
    });

    // Increment total runs used
    await userRef.update({
      totalRunsUsed: FieldValue.increment(1),
    });

    return { success: true, status: "paid", paymentIntentId: paymentIntent.id };
  }
);

// v4