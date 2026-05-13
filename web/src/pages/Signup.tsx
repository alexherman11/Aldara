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
import { createLearner, writeStoredLearner } from '@/lib/api';

const LEVELS = [
  { value: 'A1', label: 'Beginner — I know little to no Spanish' },
  { value: 'A2', label: 'Elementary — I know basic words and phrases' },
  { value: 'B1', label: 'Intermediate — I can hold simple conversations' },
  { value: 'B2', label: 'Upper Intermediate — I can discuss most topics' },
  { value: 'C1', label: 'Advanced — I speak fluently with minor gaps' },
];

export default function Signup() {
  const [, setLocation] = useLocation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [age, setAge] = useState('');
  const [level, setLevel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid =
    name.trim() && email.trim() && age.trim() && level && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const learner = await createLearner(
        {
          name: name.trim(),
          email: email.trim(),
          age: Number(age),
          cefr_initial: level,
          daily_goal_minutes: 15,
          streak: 1,
          onboarded_at: new Date().toISOString(),
        },
        level,
      );
      writeStoredLearner({
        id: learner.id,
        profile: learner.profile,
        cefr_level: learner.cefr_level,
        onboarded: false,
      });
      setLocation('/assessment');
    } catch (err) {
      console.error('Signup failed:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center p-6 overflow-y-auto"
      style={{
        background:
          'linear-gradient(160deg, hsl(38 30% 94%) 0%, hsl(32 28% 90%) 100%)',
      }}
    >
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4" style={{ width: 80, height: 80 }}>
            <Orb state="idle" />
          </div>
          <h1 className="font-serif text-5xl text-foreground mb-1.5 tracking-wide">
            Sofía
          </h1>
          <p
            className="text-sm font-semibold tracking-widest uppercase"
            style={{
              color: 'hsl(15 75% 45%)',
              textShadow: '0 0 16px hsl(15 85% 52% / 0.20)',
            }}
          >
            Tu tutora de español
          </p>
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-2xl p-6 shadow-md">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label
                  htmlFor="name"
                  className="text-muted-foreground text-sm font-medium"
                >
                  Your name
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Alex"
                  className="bg-background border-border h-11"
                  required
                  data-testid="input-name"
                />
              </div>

              <div className="space-y-1.5">
                <Label
                  htmlFor="age"
                  className="text-muted-foreground text-sm font-medium"
                >
                  Age
                </Label>
                <Input
                  id="age"
                  type="number"
                  min="5"
                  max="120"
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="25"
                  className="bg-background border-border h-11"
                  required
                  data-testid="input-age"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="email"
                className="text-muted-foreground text-sm font-medium"
              >
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
                Spanish level
              </Label>
              <Select value={level} onValueChange={setLevel} required>
                <SelectTrigger className="bg-background border-border h-11">
                  <SelectValue placeholder="How much Spanish do you know?" />
                </SelectTrigger>
                <SelectContent>
                  {LEVELS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {error && (
              <div
                className="rounded-lg px-3 py-2 text-sm"
                style={{
                  background: 'hsl(0 70% 50% / 0.08)',
                  color: 'hsl(0 70% 38%)',
                  border: '1px solid hsl(0 70% 50% / 0.25)',
                }}
              >
                Signup failed: {error}. Is the API server running on :3000?
              </div>
            )}

            <button
              type="submit"
              disabled={!valid}
              className="mt-1 w-full h-12 rounded-xl text-base font-semibold text-white transition-opacity disabled:opacity-40"
              style={{
                background:
                  'linear-gradient(135deg, hsl(15 85% 52%), hsl(28 85% 56%))',
                boxShadow: '0 4px 18px hsl(15 85% 52% / 0.25)',
              }}
              data-testid="btn-start"
            >
              {submitting ? 'Creating your profile…' : 'Start Learning →'}
            </button>
          </form>
        </div>

        <p className="mt-4 text-xs text-muted-foreground text-center">
          Sofía will run a short assessment to understand your level.
        </p>
      </div>
    </div>
  );
}
