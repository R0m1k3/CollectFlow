import { createRoot } from "react-dom/client";
import "./app/globals.css";
import { AppRouter } from "./router";

const racine = document.getElementById("root");
if (!racine) throw new Error("Élément #root introuvable dans index.html.");

createRoot(racine).render(<AppRouter />);
