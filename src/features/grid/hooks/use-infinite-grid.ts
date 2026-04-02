"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProductRow } from "@/types/grid";

export interface InfiniteGridOptions {
    codeFournisseur: string | null;
    initialTotal: number;
    pageSize?: number;
    search?: string;
    gamme?: string | null;
    code3?: string | null;
    onPageLoaded: (newRows: ProductRow[]) => void;
}

export interface InfiniteGridState {
    total: number;
    isLoadingMore: boolean;
    hasMore: boolean;
    loadNextPage: () => void;
    stopLoading: () => void;
    reset: () => void;
    progress: number;
    loadedPagesCount: number;
}

export function useInfiniteGrid({
    codeFournisseur,
    initialTotal,
    pageSize = 10000,
    search,
    gamme,
    code3,
    onPageLoaded,
}: InfiniteGridOptions): InfiniteGridState {
    const [total, setTotal] = useState(initialTotal);
    const [currentPage, setCurrentPage] = useState(0);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [isStopped, setIsStopped] = useState(false);
    const [loadedPagesCount, setLoadedPagesCount] = useState(1); // Page 0 est initialRows

    const fetchIdRef = useRef(0);
    const loadedPagesRef = useRef(new Set<number>([0]));

    const buildUrl = useCallback(
        (page: number): string => {
            if (!codeFournisseur) return "";
            const params = new URLSearchParams({
                fournisseur: codeFournisseur,
                page: String(page),
                pageSize: String(pageSize),
            });
            
            if (page > 0) {
                params.set("offset", String(200 + (page - 1) * pageSize));
            }

            if (search) params.set("search", search);
            if (gamme) params.set("gamme", gamme);
            if (code3) params.set("code3", code3);
            return `/api/grid/rows?${params.toString()}`;
        },
        [codeFournisseur, pageSize, search, gamme, code3]
    );

    useEffect(() => {
        setTotal(initialTotal);
        setCurrentPage(0);
        setLoadedPagesCount(1);
        setIsStopped(false);
        loadedPagesRef.current = new Set([0]);
        fetchIdRef.current += 1;
    }, [codeFournisseur, initialTotal, search, gamme, code3]);

    const loadNextPage = useCallback(async () => {
        if (!codeFournisseur || isLoadingMore || isStopped) return;

        const nextPage = currentPage + 1;
        const alreadyLoaded = loadedPagesRef.current.has(nextPage);
        const totalPages = Math.ceil(total / pageSize);

        if (alreadyLoaded || nextPage >= totalPages) return;

        const currentFetchId = ++fetchIdRef.current;
        setIsLoadingMore(true);

        try {
            const url = buildUrl(nextPage);
            const response = await fetch(url, { credentials: "same-origin" });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            if (currentFetchId !== fetchIdRef.current) return;

            const data = await response.json() as {
                rows: ProductRow[];
                total: number;
                page: number;
                pageSize: number;
                totalPages: number;
            };

            loadedPagesRef.current.add(nextPage);
            setLoadedPagesCount(prev => prev + 1);
            setTotal(data.total);
            setCurrentPage(nextPage);
            
            // Envoyer directement au Store Zustand pour bypasser le cycle React DOM
            onPageLoaded(data.rows);
        } catch (error) {
            if ((error as Error).name === "AbortError") return;
            console.error("[useInfiniteGrid] loadNextPage error:", error);
        } finally {
            if (currentFetchId === fetchIdRef.current) {
                setIsLoadingMore(false);
            }
        }
    }, [codeFournisseur, currentPage, total, pageSize, isLoadingMore, isStopped, buildUrl, onPageLoaded]);

    const stopLoading = useCallback(() => {
        setIsStopped(true);
        setIsLoadingMore(false);
    }, []);

    const reset = useCallback(() => {
        fetchIdRef.current += 1;
        loadedPagesRef.current = new Set([0]);
        setTotal(initialTotal);
        setCurrentPage(0);
        setLoadedPagesCount(1);
        setIsLoadingMore(false);
        setIsStopped(false);
    }, [initialTotal]);

    // On part du principe qu'il y en a 200 + n * 10 000
    const loadedItemsEstimation = 200 + (loadedPagesCount - 1) * pageSize;
    const hasMore = !isStopped && loadedItemsEstimation < total;
    const progress = total > 0 ? Math.round(Math.min((loadedItemsEstimation / total) * 100, 100)) : 100;

    return {
        total,
        isLoadingMore,
        hasMore,
        loadNextPage,
        stopLoading,
        reset,
        progress,
        loadedPagesCount,
    };
}
