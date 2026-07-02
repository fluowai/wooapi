import { LogOut, ArrowLeft } from 'lucide-react';

interface Props {
  accountName?: string;
  accountEmail?: string;
  onBackToAdmin: () => void;
  onLogout: () => void;
}

export default function ImpersonationBanner({ accountName, accountEmail, onBackToAdmin, onLogout }: Props) {
  return (
    <div className="flex items-center justify-between gap-4 bg-red-600 px-4 py-2 text-sm text-white">
      <div className="flex items-center gap-3">
        <span className="font-bold">Visualizando como {accountName || 'usuário'}</span>
        {accountEmail && <span className="text-red-100 text-xs">{accountEmail}</span>}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onBackToAdmin}
          className="inline-flex items-center gap-1.5 rounded-md bg-white/20 px-3 py-1.5 text-xs font-bold hover:bg-white/30"
        >
          <ArrowLeft size={14} />
          Voltar ao admin
        </button>
        <button
          onClick={onLogout}
          className="inline-flex items-center gap-1.5 rounded-md bg-white/20 px-3 py-1.5 text-xs font-bold hover:bg-white/30"
        >
          <LogOut size={14} />
          Sair
        </button>
      </div>
    </div>
  );
}
