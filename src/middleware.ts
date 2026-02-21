export { auth as middleware } from "@/lib/auth";

export const config = {
    // Next.js 16+: use 'matcher' with App Router routes only
    matcher: [
        "/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$).*)",
    ],
};
