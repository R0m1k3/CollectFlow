export default function PublicitesLoading() {
    return (
        <div className="min-h-screen bg-gray-50 p-6">
            <div className="mx-auto max-w-screen-xl">
                <div className="mb-6 h-9 w-48 animate-pulse rounded-lg bg-gray-200" />
                <div className="space-y-4">
                    <div className="h-16 animate-pulse rounded-xl bg-white shadow-sm border border-gray-100" />
                    <div className="animate-pulse rounded-xl bg-white shadow-sm border border-gray-100">
                        <div className="h-10 bg-gray-50 rounded-t-xl border-b border-gray-200" />
                        {Array.from({ length: 8 }).map((_, i) => (
                            <div key={i} className="flex items-center gap-4 border-b border-gray-100 px-4 py-3">
                                <div className="h-4 w-12 bg-gray-100 rounded" />
                                <div className="h-4 flex-1 bg-gray-100 rounded" />
                                <div className="h-4 w-24 bg-gray-100 rounded" />
                                <div className="h-4 w-24 bg-gray-100 rounded" />
                                <div className="h-4 w-28 bg-orange-50 rounded" />
                                <div className="h-4 w-16 bg-orange-50 rounded" />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
