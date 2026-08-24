import NextAuth from "next-auth";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { NextAuthOptions } from "next-auth";
import { prisma } from "../../../server/db/client";
import { serverEnv } from "../../../utils/env/server";
import AzureADProvider from "next-auth/providers/azure-ad";
import GoogleProvider from "next-auth/providers/google";
import { Adapter } from "next-auth/adapters";
import { Prisma } from "@prisma/client";

const CustomPrismaAdapter = (p: typeof prisma): Adapter => {
  return {
    ...PrismaAdapter(p),
    createUser: async (data: Prisma.UserCreateInput) => {
      const user = await p.user.create({
        data: {
          ...data,
          image: null,
        },
      });
      return {
        ...user,
        email: user.email || "",
      };
    },
  };
};

export const authOptions: NextAuthOptions = {
  callbacks: {
    session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        session.user.isOnboarded = user.isOnboarded;
        session.user.tutorialCompleted = user.tutorialCompleted;
        session.user.permission = user.permission;
      }
      return session;
    },
  },
  secret: serverEnv.NEXTAUTH_SECRET,
  logger: {
    // NextAuth passes provider payloads through `metadata`, which can carry
    // token material and the signing-in user's address. The code identifies
    // the fault on its own, so metadata stays out of production logs.
    error(code, metadata) {
      if (process.env.NODE_ENV === "production") {
        console.error(code);
      } else {
        console.error(code, metadata);
      }
    },
    warn(code) {
      console.warn(code);
    },
    debug(code, metadata) {
      if (process.env.NODE_ENV !== "production") {
        console.debug(code, metadata);
      }
    },
  },
  adapter: CustomPrismaAdapter(prisma),

  providers:
    process.env.NEXT_PUBLIC_ENV === "staging"
      ? [
          GoogleProvider({
            clientId: serverEnv.GOOGLE_CLIENT_ID,
            clientSecret: serverEnv.GOOGLE_CLIENT_SECRET,
          }),
          AzureADProvider({
            clientId: serverEnv.AZURE_CLIENT_ID,
            clientSecret: serverEnv.AZURE_CLIENT_SECRET,
            tenantId: serverEnv.AZURE_TENANT_ID,
          }),
        ]
      : [
          AzureADProvider({
            clientId: serverEnv.AZURE_CLIENT_ID,
            clientSecret: serverEnv.AZURE_CLIENT_SECRET,
            tenantId: serverEnv.AZURE_TENANT_ID,
          }),
        ],
};

export default NextAuth(authOptions);
