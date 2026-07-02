import React, { useState, useEffect } from 'react';
import { Building2, RefreshCw } from 'lucide-react';
import { motion } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const Card = ({ children, className }: { children: React.ReactNode, className?: string }) => (
  <div className={cn("rounded-xl border border-slate-200 bg-white shadow-sm", className)}>{children}</div>
);

const displayText = (value: any, fallback = '-') => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => displayText(item, '')).filter(Boolean).join(', ') || fallback;
  if (typeof value === 'object') {
    return value.name || value.label || value.title || value.email || value.id || fallback;
  }
  return String(value);
};

const displayNumber = (value: any, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

interface ResellerPanelProps {
  apiFetch: (url: string, options?: any) => Promise<any>;
  onImpersonate: (session: any) => void;
  onImpersonateSupport?: (accountId: number) => void;
}

export default function ResellerPanel({ apiFetch, onImpersonate }: ResellerPanelProps) {
  const [resellerOverview, setResellerOverview] = useState<any>(null);
  const [clientAccounts, setClientAccounts] = useState<any[]>([]);
  const [newClient, setNewClient] = useState({ name: '', owner_name: '', owner_email: '', password: '', instance_quota: 1, max_client_accounts: 0 });

  const fetchResellerOverview = async () => {
    const data = await apiFetch('/api/reseller/overview');
    if (data) setResellerOverview(data);
  };

  const fetchClientAccounts = async () => {
    const data = await apiFetch('/api/reseller/clients');
    if (data) setClientAccounts(data);
  };

  const createClientAccount = async () => {
    if (!newClient.name || !newClient.owner_name || !newClient.owner_email || !newClient.password) return;
    const data = await apiFetch('/api/reseller/clients', {
      method: 'POST',
      body: JSON.stringify(newClient)
    });
    if (!data?.id) return;
    setNewClient({ name: '', owner_name: '', owner_email: '', password: '', instance_quota: 1, max_client_accounts: 0 });
    fetchClientAccounts();
    fetchResellerOverview();
  };

  const impersonateClient = async (accountId: number) => {
    const session = await apiFetch(`/api/admin/accounts/${accountId}/impersonate`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Suporte via Revenda' })
    });
    if (session?.token) onImpersonate(session);
  };

  const resetNewClient = () => {
    setNewClient({ name: '', owner_name: '', owner_email: '', password: '', instance_quota: 1, max_client_accounts: 0 });
  };

  useEffect(() => {
    fetchResellerOverview();
    fetchClientAccounts();
  }, []);

  return (
    <motion.div
      key="clients"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex items-center justify-between">
        <header>
          <h2 className="text-3xl font-bold">Clientes SaaS</h2>
          <p className="text-slate-500">Crie contas clientes com cotas próprias de instâncias Wozapi.</p>
        </header>
        <button onClick={() => { fetchResellerOverview(); fetchClientAccounts(); }} className="flex items-center gap-2 rounded-md bg-slate-900 px-4 py-3 text-sm font-bold text-white hover:bg-primary">
          <RefreshCw size={16} />
          Atualizar
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5">
          <p className="text-xs uppercase font-bold text-slate-400">Clientes usados</p>
          <p className="text-3xl font-black mt-1">{displayNumber(resellerOverview?.usage?.client_accounts)}/{displayText(resellerOverview?.plan?.max_client_accounts)}</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs uppercase font-bold text-slate-400">Instâncias disponíveis</p>
          <p className="text-3xl font-black mt-1">{displayText(resellerOverview?.available_instances)}</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs uppercase font-bold text-slate-400">Instâncias alocadas</p>
          <p className="text-3xl font-black mt-1">{displayNumber(resellerOverview?.usage?.allocated_child_instances)}</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
        <Card className="p-5 h-fit">
          <h3 className="text-lg font-bold mb-4">Novo cliente</h3>
          <div className="space-y-3">
            <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="Empresa" value={newClient.name} onChange={e => setNewClient({ ...newClient, name: e.target.value })} />
            <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="Nome do admin" value={newClient.owner_name} onChange={e => setNewClient({ ...newClient, owner_name: e.target.value })} />
            <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="E-mail do admin" value={newClient.owner_email} onChange={e => setNewClient({ ...newClient, owner_email: e.target.value })} />
            <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" placeholder="Senha inicial" type="password" value={newClient.password} onChange={e => setNewClient({ ...newClient, password: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" type="number" min="0" value={newClient.instance_quota} onChange={e => setNewClient({ ...newClient, instance_quota: Number(e.target.value) })} />
              <input className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm" type="number" min="0" value={newClient.max_client_accounts} onChange={e => setNewClient({ ...newClient, max_client_accounts: Number(e.target.value) })} />
            </div>
            <button onClick={createClientAccount} className="w-full py-3 bg-primary text-white font-bold rounded-md">Criar cliente</button>
          </div>
        </Card>

        <Card className="xl:col-span-3 overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-slate-400 text-xs font-semibold uppercase tracking-wider">
                <th className="py-4 px-6">Conta</th>
                <th className="py-4 px-6">Cota</th>
                <th className="py-4 px-6">Uso</th>
                <th className="py-4 px-6">Status</th>
                <th className="py-4 px-6">Ação</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {clientAccounts.map((client) => (
                <tr key={client.id} className="border-b border-slate-50 last:border-0">
                  <td className="py-4 px-6">
                    <p className="font-bold">{client.name}</p>
                    <p className="text-xs text-slate-400">{client.owner_email}</p>
                  </td>
                  <td className="py-4 px-6">{client.instance_quota || 0} instâncias</td>
                  <td className="py-4 px-6">{client.usage?.instances || 0}/{client.instance_quota || 0}</td>
                  <td className="py-4 px-6">
                    <span className={cn("px-2 py-1 rounded text-xs font-bold", client.status === 'active' ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>
                      {client.status || 'active'}
                    </span>
                  </td>
                  <td className="py-4 px-6">
                    <button
                      onClick={() => impersonateClient(client.id)}
                      className="px-3 py-1.5 bg-slate-900 text-white rounded-md text-xs font-bold hover:bg-primary"
                    >
                      Acessar
                    </button>
                  </td>
                </tr>
              ))}
              {clientAccounts.length === 0 && (
                <tr>
                  <td className="py-8 px-6 text-slate-400 text-center" colSpan={5}>Nenhum cliente criado ainda.</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </motion.div>
  );
}
