"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProductRow } from "@/types/grid";

export interface InfiniteGridOptions {
    codeFournisseur: string | null;
    initialRows: ProductRow[];
    initialTotal: number;
    pageSize?: number;
    search?: string;
    gamme?: string | null;
    code3?: string | null;
}

export interface InfiniteGridState {
    rows: ProductRow[];
    total: number;
    isLoadingMore: boolean;
    hasMore: boolean;
    loadNextPage: () => void;
    reset: () => void;
    progress: number;
}

export function useInfiniteGrid({
    codeFournisseur,
    initialRows,
    initialTotal,
    pageSize = 200,
    search,
    gamme,
    code3,
}: InfiniteGridOptions): InfiniteGridState {
    const [rows, setRows] = useState<ProductRow[]>(initialRows);
    const [total, setTotal] = useState(initialTotal);
    const [currentPage, setCurrentPage] = useState(0);
    const [isLoadingMore, setIsLoadingMore] = useState(false);

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
            if (search) params.set("search", search);
            if (gamme) params.set("gamme", gamme);
            if (code3) params.set("code3", code3);
            return `/api/grid/rows?${params.toString()}`;
        },
        [codeFournisseur, pageSize, search, gamme, code3]
    );

    useEffect(() => {
        setRows(initialRows);
        setTotal(initialTotal);
        setCurrentPage(0);
        loadedPagesRef.current = new Set([0]);
        fetchIdRef.current += 1;
    }, [codeFournisseur, initialRows, initialTotal, search, gamme, code3]);

    const loadNextPage = useCallback(async () => {
        if (!codeFournisseur || isLoadingMore) return;

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
            setRows(prev => [...prev, ...data.rows]);
            setTotal(data.total);
            setCurrentPage(nextPage);
        } catch (error) {
            console.error("[useInfiniteGrid] loadNextPage error:", error);
        } finally {
            if (currentFetchId === fetchIdRef.current) {
                setIsLoadingMore(false);
            }
        }
    }, [codeFournisseur, currentPage, total, pageSize, isLoadingMore, buildUrl]);

    const reset = useCallback(() => {
        fetchIdRef.current += 1;
        loadedPagesRef.current = new Set([0]);
        setRows(initialRows);
        setTotal(initialTotal);
        setCurrentPage(0);
        setIsLoadingMore(false);
    }, [initialRows, initialTotal]);

    const hasMore = rows.length < total;
    const progress = total > 0 ? Math.round((rows.length / total) * 100) : 100;

    return {
        rows,
        total,
        isLoadingMore,
        hasMore,
        loadNextPage,
        reset,
        progress,
    };
}
