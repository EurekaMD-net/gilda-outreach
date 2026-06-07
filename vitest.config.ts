import { defineConfig } from "vitest/config";

// Pin test process to America/Mexico_City to match the production systemd TZ.
// The send-window gate (Mon–Fri 10:00–18:00) and daily-counter keys ('YYYY-MM-DD'
// in MX time) are local-TZ; without this, tests pass in a UTC env but hide bugs
// the same code reveals on the MX-TZ VPS. Per global feedback_timezone_utc rule.
process.env.TZ = "America/Mexico_City";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
