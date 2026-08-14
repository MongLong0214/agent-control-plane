import app from "./src/app.js";

if (app() !== 2) {
  console.error("expected app() === 2");
  process.exit(1);
}

console.log("verification ok");
