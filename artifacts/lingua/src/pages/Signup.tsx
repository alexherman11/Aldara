import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { Orb } from '@/components/Orb';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const NATIVE_LANGUAGES = [
  'English', 'French', 'German', 'Portuguese', 'Italian',
  'Mandarin Chinese', 'Japanese', 'Korean', 'Arabic', 'Hindi', 'Other',
];

export default function Signup() {
  const [, setLocation] = useLocation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [nativeLang, setNativeLang] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email || !nativeLang) return;
    localStorage.setItem(
      'lingua_user',
      JSON.stringify({ name, email, nativeLang, isNew: true, streak: 5 }),
    );
    setLocation('/assessment');
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 bg-gradient-to-b from-background to-card/70 overflow-y-auto">
      <div className="mb-5 flex flex-col items-center text-center">
        <h1 className="font-serif text-5xl text-foreground mb-2 tracking-wide">Lingua</h1>
        <p
          className="text-sm font-semibold tracking-widest uppercase"
          style={{ color: 'hsl(15 85% 52%)', textShadow: '0 0 12px hsl(15 85% 52% / 0.35)' }}
        >
          Tu tutor de español
        </p>
      </div>

      <div className="mb-7" style={{ width: 88, height: 88 }} data-testid="signup-orb">
        <Orb state="idle" />
      </div>

      <div className="w-full max-w-sm">
        <div className="bg-card/70 backdrop-blur-md border border-border rounded-2xl p-6 shadow-lg">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="name" className="text-muted-foreground text-sm font-medium">
                Your name
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="What should I call you?"
                className="bg-background border-border h-11"
                required
                data-testid="input-name"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-muted-foreground text-sm font-medium">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="bg-background border-border h-11"
                required
                data-testid="input-email"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-sm font-medium">
                Native language
              </Label>
              <Select value={nativeLang} onValueChange={setNativeLang} required>
                <SelectTrigger className="bg-background border-border h-11">
                  <SelectValue placeholder="Select your language" />
                </SelectTrigger>
                <SelectContent>
                  {NATIVE_LANGUAGES.map((lang) => (
                    <SelectItem key={lang} value={lang}>{lang}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <button
              type="submit"
              disabled={!name || !email || !nativeLang}
              className="mt-2 w-full h-12 rounded-xl text-base font-semibold text-white transition-opacity disabled:opacity-50"
              style={{
                background: 'linear-gradient(135deg, hsl(15 85% 52%), hsl(28 85% 56%))',
                boxShadow: '0 4px 18px hsl(15 85% 52% / 0.30)',
              }}
              data-testid="btn-start"
            >
              Start Learning →
            </button>
          </form>
        </div>
      </div>

      <p className="mt-6 text-xs text-muted-foreground text-center max-w-xs">
        Dara, your AI tutor, will run a short assessment to understand your Spanish level.
      </p>
    </div>
  );
}
