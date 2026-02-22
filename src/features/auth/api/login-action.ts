"use server";

import { signIn } from "@/lib/auth";
import { AuthError } from "next-auth";

/**
 * Server action to handle user login.
 */
export async function loginAction(prevState: string | undefined, formData: FormData) {
    try {
        await signIn("credentials", {
            username: formData.get("username"),
            password: formData.get("password"),
            redirectTo: "/grid"
        });
    } catch (error) {
        if (error instanceof AuthError) {
            switch (error.type) {
                case "CredentialsSignin":
                    return "Utilisateur ou mot de passe incorrect.";
                default:
                    return "Une erreur technique est survenue.";
            }
        }
        // Next.js redirect throws a special error that must be rethrown
        throw error;
    }
}
