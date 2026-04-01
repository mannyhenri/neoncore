import { useState, useEffect, useMemo } from 'react';
import { api } from '../lib/api';
import type { McpRegistryEntry } from '../types';

interface Props {
  onBack: () => void;
  onServerAdded: () => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  'Communication': 'bg-blue-900/50 text-blue-300',
  'Developer Tools': 'bg-gray-700/50 text-gray-300',
  'Productivity': 'bg-green-900/50 text-green-300',
  'AI Models': 'bg-purple-900/50 text-purple-300',
  'Creative': 'bg-pink-900/50 text-pink-300',
  'Search & Web': 'bg-cyan-900/50 text-cyan-300',
  'Data & Files': 'bg-amber-900/50 text-amber-300',
};

export function McpMarketplace({ onBack, onServerAdded }: Props) {
  const [registry, setRegistry] = useState<McpRegistryEntry[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [installing, setInstalling] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.getMcpRegistry()
      .then(({ servers, categories: cats, installed: inst }) => {
        setRegistry(servers);
        setCategories(cats);
        setInstalled(new Set(inst));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let list = registry;
    if (categoryFilter) {
      list = list.filter((s) => s.category === categoryFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    // Featured first, then alphabetical
    return [...list].sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [registry, search, categoryFilter]);

  const handleInstall = async (entry: McpRegistryEntry) => {
    setInstalling((prev) => new Set(prev).add(entry.slug));
    try {
      // Convert registry env (with metadata) to flat Record<string, string> for the server
      const flatEnv: Record<string, string> = {};
      for (const [key, field] of Object.entries(entry.env)) {
        flatEnv[key] = field.placeholder || '';
      }
      await api.addMcpServer({
        command: entry.command,
        name: entry.name,
        args: entry.args,
        env: flatEnv,
        slug: entry.slug,
        description: entry.description,
      });
      setInstalled((prev) => new Set(prev).add(entry.slug));
      onServerAdded();
    } catch {
      // ignore
    } finally {
      setInstalling((prev) => {
        const next = new Set(prev);
        next.delete(entry.slug);
        return next;
      });
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="text-sm text-gray-400 hover:text-white flex items-center gap-1.5 transition-colors"
        >
          <span className="text-lg leading-none">&larr;</span> Back to servers
        </button>
        <h3 className="text-base font-semibold text-gray-200">MCP Marketplace</h3>
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search servers..."
        className="w-full glass-input text-sm text-gray-200 rounded-lg px-3 py-2 placeholder-gray-500 focus:outline-none"
      />

      {/* Category filters */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => setCategoryFilter(null)}
          className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
            !categoryFilter
              ? 'bg-gl-purple/20 text-gl-purple border border-gl-purple/40'
              : 'bg-white/[0.04] text-gray-400 border border-white/[0.06] hover:bg-white/[0.08]'
          }`}
        >
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
            className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
              categoryFilter === cat
                ? 'bg-gl-purple/20 text-gl-purple border border-gl-purple/40'
                : 'bg-white/[0.04] text-gray-400 border border-white/[0.06] hover:bg-white/[0.08]'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Server grid */}
      {loading ? (
        <div className="text-center py-12 text-gray-500 text-sm">Loading marketplace...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">No servers found</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map((entry) => {
            const isInstalled = installed.has(entry.slug);
            const isInstalling = installing.has(entry.slug);
            const catColor = CATEGORY_COLORS[entry.category] || 'bg-gray-700/50 text-gray-300';

            return (
              <div
                key={entry.slug}
                className={`border rounded-lg p-3.5 transition-colors ${
                  isInstalled
                    ? 'border-green-800/40 bg-green-950/20'
                    : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-gray-200">{entry.name}</span>
                      {entry.featured && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400 font-medium">
                          Popular
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 leading-relaxed">{entry.description}</p>
                  </div>
                  <button
                    onClick={() => !isInstalled && handleInstall(entry)}
                    disabled={isInstalled || isInstalling}
                    className={`shrink-0 text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
                      isInstalled
                        ? 'bg-green-900/30 text-green-400 cursor-default'
                        : isInstalling
                          ? 'bg-white/[0.06] text-gray-500 cursor-wait'
                          : 'bg-gl-purple/20 text-gl-purple hover:bg-gl-purple/30 border border-gl-purple/30'
                    }`}
                  >
                    {isInstalled ? 'Installed' : isInstalling ? 'Adding...' : 'Add'}
                  </button>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${catColor}`}>
                    {entry.category}
                  </span>
                  {Object.keys(entry.env).length > 0 && (
                    <span className="text-[10px] text-gray-600">
                      Requires: {Object.values(entry.env).map((f) => f.label).join(', ')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
