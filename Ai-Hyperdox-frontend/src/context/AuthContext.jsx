import { createContext, useContext, useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  updateEmail,
  GoogleAuthProvider,
  signInWithPopup,
} from "firebase/auth";
import { httpsCallable }       from "firebase/functions";
import { doc, setDoc, getDoc } from "firebase/firestore";
import { auth, db, functions } from "../firebase";

const AuthContext = createContext();

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading]         = useState(true);

  async function register(email, password, name = "") {
    console.log("🔥 register() called — NEW VERSION");

    // Step 1 — Create the Firebase Auth user
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user           = userCredential.user;

    // Step 2 — Write Firestore user doc
    await setDoc(doc(db, "users", user.uid), {
      fullName:          name,
      email:             email,
      company:           "",
      industry:          "",
      createdAt:         new Date().toISOString(),
      provider:          "email",
      freeRunsRemaining: 3,
      totalRunsUsed:     0,
    });

    // Step 3 — Send verification email (wrapped so it never blocks registration)
    try {
      const sendVerification = httpsCallable(functions, "sendVerificationEmail");
      await sendVerification({ uid: user.uid, name });
    } catch (emailErr) {
      // Log but don't throw — user is created, email just didn't send
      console.warn("⚠️ Verification email failed to send:", emailErr.message);
    }

    return userCredential;
  }

  function login(email, password) {
    return signInWithEmailAndPassword(auth, email, password);
  }

  function logout() {
    return signOut(auth);
  }

  async function loginWithGoogle() {
    const provider       = new GoogleAuthProvider();
    const userCredential = await signInWithPopup(auth, provider);
    const user           = userCredential.user;

    const userRef  = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      await setDoc(userRef, {
        fullName:          user.displayName || "",
        email:             user.email       || "",
        company:           "",
        industry:          "",
        createdAt:         new Date().toISOString(),
        provider:          "google",
        freeRunsRemaining: 3,
        totalRunsUsed:     0,
      });
    }

    return userCredential;
  }

  async function sendPasswordReset(email, name = "") {
    // Use public HTTP fallback endpoint (sendPasswordResetEmailHttp)
    const url = "https://us-central1-ai-hyperdox.cloudfunctions.net/sendPasswordResetEmailHttp";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    // Map HTTP errors to codes similar to Firebase errors for existing handlers
    if (res.status === 404) throw { code: "auth/user-not-found", message: data.error || "No account found" };
    if (res.status === 400) throw { code: "auth/invalid-email", message: data.error || "Invalid email" };
    if (res.status === 429) throw { code: "auth/too-many-requests", message: data.error || "Too many requests" };
    throw { code: "functions/internal", message: data.error || "Failed to send reset link" };
  }

  async function resendVerificationEmail(name = "") {
    if (!auth.currentUser) throw new Error("No user logged in");
    const sendVerification = httpsCallable(functions, "sendVerificationEmail");
    return sendVerification({
      uid:  auth.currentUser.uid,
      name: name || auth.currentUser.displayName || "",
    });
  }

  function updateUserProfile(data)   { return updateProfile(auth.currentUser, data); }
  function updateUserEmail(newEmail) { return updateEmail(auth.currentUser, newEmail); }

  async function saveUserDoc(uid, data) {
    return setDoc(doc(db, "users", uid), data, { merge: true });
  }

  async function getUserDoc(uid) {
    const snap = await getDoc(doc(db, "users", uid));
    return snap.exists() ? snap.data() : {};
  }

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const value = {
    currentUser,
    register,
    login,
    logout,
    loginWithGoogle,
    sendPasswordReset,
    resendVerificationEmail,
    updateUserProfile,
    updateUserEmail,
    saveUserDoc,
    getUserDoc,
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
}