"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2, X } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

interface SuccessModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    message: string;
    duration?: number;
}

export function SuccessModal({
    isOpen,
    onClose,
    title,
    message,
    duration = 3000
}: SuccessModalProps) {
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setIsVisible(true);
            const timer = setTimeout(() => {
                handleClose();
            }, duration);
            return () => clearTimeout(timer);
        }
    }, [isOpen, duration]);

    const handleClose = () => {
        setIsVisible(false);
        setTimeout(onClose, 300); // Wait for fade out animation
    };

    if (!isOpen && !isVisible) return null;

    return (
        <div
            className={cn(
                "fixed inset-0 z-[100] flex items-center justify-center p-4 transition-all duration-300",
                isVisible ? "opacity-100 backdrop-blur-sm" : "opacity-0 backdrop-blur-0"
            )}
        >
            <div
                className="fixed inset-0 bg-slate-950/40"
                onClick={handleClose}
            />

            <div
                className={cn(
                    "relative w-full max-w-sm overflow-hidden rounded-3xl border border-slate-200/50 dark:border-slate-800/50 bg-white dark:bg-slate-900 shadow-2xl transition-all duration-300 transform",
                    isVisible ? "scale-100 translate-y-0" : "scale-95 translate-y-4"
                )}
            >
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-400 to-teal-500" />

                <button
                    onClick={handleClose}
                    className="absolute top-4 right-4 p-1 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>

                <div className="p-8 flex flex-col items-center text-center">
                    <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-6 animate-bounce-slow">
                        <CheckCircle2 className="w-8 h-8 text-emerald-500" />
                    </div>

                    <h3 className="text-xl font-black text-slate-900 dark:text-slate-100 mb-2 tracking-tight">
                        {title}
                    </h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400 font-medium leading-relaxed">
                        {message}
                    </p>

                    <button
                        onClick={handleClose}
                        className="mt-8 w-full py-3 rounded-2xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold text-sm transition-all active:scale-95 hover:brightness-110 shadow-lg shadow-slate-900/10"
                    >
                        Continuer
                    </button>
                </div>
            </div>

            <style jsx global>{`
        @keyframes bounce-slow {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        .animate-bounce-slow {
          animation: bounce-slow 2s ease-in-out infinite;
        }
      `}</style>
        </div>
    );
}
