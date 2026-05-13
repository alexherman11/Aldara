import { useLocation } from "wouter";

export default function NotFound() {
  const [, setLocation] = useLocation();
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 bg-background text-center">
      <p className="font-serif text-5xl text-foreground mb-2">404</p>
      <p className="text-muted-foreground mb-6">Page not found</p>
      <button
        onClick={() => setLocation('/home')}
        className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
        style={{ background: 'linear-gradient(135deg, hsl(15 85% 52%), hsl(28 85% 56%))' }}
      >
        Go Home
      </button>
    </div>
  );
}
