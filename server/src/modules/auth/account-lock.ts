import type { Prisma } from "@prisma/client";

export async function lockActiveAccount(tx: Prisma.TransactionClient, userId: string) {
  const rows = await tx.$queryRaw<Array<{ passwordHash: string }>>`
    SELECT password_hash AS "passwordHash" FROM users
    WHERE id = ${userId}::uuid AND deleted_at IS NULL FOR UPDATE`;
  return rows[0] ?? null;
}
