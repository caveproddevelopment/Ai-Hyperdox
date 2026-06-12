import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth }      from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";
import { getStorage }   from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyA2v4N6EqQbXgzELxpslIoHC-FsUqO2yOw",
  authDomain: "ai-hyperdox.firebaseapp.com",
  projectId: "ai-hyperdox",
  storageBucket: "ai-hyperdox.firebasestorage.app",
  messagingSenderId: "227083909647",
  appId: "1:227083909647:web:d770e9f4ef2e5b3d8f017a",
  measurementId: "G-F23W191F74"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const auth      = getAuth(app);
export const db        = getFirestore(app);
export const functions = getFunctions(app, "us-central1");
export const storage   = getStorage(app);
export default app;