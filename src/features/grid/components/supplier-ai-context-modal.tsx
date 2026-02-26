"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Brain } from "lucide-react";

interface SupplierAiContextModalProps {
    codeFournisseur: string | null;
    nomFournisseur: string | null;
}

export function SupplierAiContextModal({ codeFournisseur, nomFournisseur }: SupplierAiContextModalProps) {
    const [open, setOpen] = useState(false);
    const [context, setContext] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (open && codeFournisseur) {
            fetchContext();
        }
    }, [open, codeFournisseur]);

    const fetchContext = async () => {
        setIsLoading(true);
        try {
            const res = await fetch(`/api/ai/context?fournisseur=${codeFournisseur}`);
            if (res.ok) {
                const data = await res.json();
                setContext(data.context || "");
            }
        } catch (error) {
            console.error("Failed to load AI context", error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSave = async () => {
        if (!codeFournisseur) return;

        setIsSaving(true);
        try {
            const res = await fetch("/api/ai/context", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ codeFournisseur, context }),
            });

            if (res.ok) {
                setOpen(false);
            } else {
                console.error("Failed to save AI context");
            }
        } catch (error) {
            console.error("Failed to save AI context", error);
        } finally {
            setIsSaving(false);
        }
    };

    if (!codeFournisseur) return null;

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                    <Brain className="w-4 h-4" />
                    Règles IA
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>Contexte IA - {nomFournisseur || codeFournisseur}</DialogTitle>
                    <DialogDescription>
                        Définissez ici les règles métier absolues pour ce fournisseur.
                        Mary (l'IA) respectera ces consignes en priorité lors de ses recommandations (ex: "Les calendriers vont en gamme C").
                    </DialogDescription>
                </DialogHeader>

                <div className="py-4">
                    <Textarea
                        placeholder="Ex: Les produits dont le nom contient 'Agenda' doivent toujours être classés en [A]..."
                        value={context}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContext(e.target.value)}
                        disabled={isLoading}
                        className="min-h-[150px]"
                    />
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)} disabled={isSaving}>
                        Annuler
                    </Button>
                    <Button onClick={handleSave} disabled={isSaving || isLoading} className="gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-700 hover:to-indigo-700">
                        {isSaving ? "Enregistrement..." : "Enregistrer les règles"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
