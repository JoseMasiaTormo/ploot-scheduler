// Genera JWT de prueba para los Embajadores del seed.
// Uso: JWT_SECRET=... npm run tokens
import { SignJWT } from "jose";

const secret = process.env.JWT_SECRET ?? "dev-only-jwt-secret-at-least-32-chars";

const profiles = [
  {
    name: "Ana (Acme)",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    profile_id: "a1111111-1111-4111-8111-111111111111",
  },
  {
    name: "Diego (Globex)",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    profile_id: "b1111111-1111-4111-8111-111111111111",
  },
];

async function main() {
  for (const p of profiles) {
    const token = await new SignJWT({ tenant_id: p.tenant_id, profile_id: p.profile_id })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(p.profile_id)
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode(secret));
    console.log(`${p.name}:\n${token}\n`);
  }
}

main();
