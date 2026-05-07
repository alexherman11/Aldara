import React from 'react';
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AnimatePresence, motion } from "framer-motion";
import NotFound from "@/pages/not-found";

import Signup from "@/pages/Signup";
import Assessment from "@/pages/Assessment";
import DailyGoal from "@/pages/DailyGoal";
import Home from "@/pages/Home";
import Session from "@/pages/Session";
import Summary from "@/pages/Summary";

const queryClient = new QueryClient();

const PageWrapper = ({ children, path }: { children: React.ReactNode; path: string }) => (
  <motion.div
    key={path}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.28, ease: "easeInOut" }}
    className="absolute inset-0 flex flex-col overflow-hidden"
  >
    {children}
  </motion.div>
);

function RouteGuard() {
  const [location, setLocation] = useLocation();

  React.useEffect(() => {
    if (location === '/') {
      const user = localStorage.getItem('lingua_user');
      setLocation(user ? '/home' : '/signup');
    }
  }, [location, setLocation]);

  if (location === '/') return null;

  return (
    <AnimatePresence>
      <Switch location={location} key={location}>
        <Route path="/signup">
          <PageWrapper path="/signup"><Signup /></PageWrapper>
        </Route>
        <Route path="/assessment">
          <PageWrapper path="/assessment"><Assessment /></PageWrapper>
        </Route>
        <Route path="/daily-goal">
          <PageWrapper path="/daily-goal"><DailyGoal /></PageWrapper>
        </Route>
        <Route path="/home">
          <PageWrapper path="/home"><Home /></PageWrapper>
        </Route>
        <Route path="/session">
          <PageWrapper path="/session"><Session /></PageWrapper>
        </Route>
        <Route path="/summary">
          <PageWrapper path="/summary"><Summary /></PageWrapper>
        </Route>
        <Route>
          <PageWrapper path="404"><NotFound /></PageWrapper>
        </Route>
      </Switch>
    </AnimatePresence>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/* Outer wrap — full viewport, dark background */}
        <div
          className="min-h-[100dvh] w-full flex items-center justify-center"
          style={{ background: 'hsl(222 20% 6%)' }}
        >
          {/* Phone-frame container — relative + fixed height so absolute pages overlay */}
          <div className="relative w-full max-w-[430px] h-[100dvh] bg-background overflow-hidden shadow-2xl">
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <RouteGuard />
            </WouterRouter>
          </div>
        </div>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
