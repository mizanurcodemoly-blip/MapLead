import React, { useState, useEffect } from "react";
import { 
  Search, 
  Download, 
  MapPin, 
  Phone, 
  Globe, 
  Mail, 
  Star, 
  RefreshCw, 
  Trash2, 
  ChevronRight,
  Database,
  LayoutDashboard,
  Settings as SettingsIcon,
  ExternalLink,
  Filter,
  CheckCircle2,
  AlertCircle,
  LogIn,
  LogOut,
  User as UserIcon,
  Sparkles
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { GoogleGenAI, Type } from "@google/genai";
import Papa from "papaparse";
import { cn } from "@/src/lib/utils";
import { Lead, SearchParams } from "@/src/types";
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  doc, 
  getDoc, 
  setDoc, 
  deleteDoc, 
  collection, 
  query, 
  where, 
  onSnapshot,
  User
} from "./firebase";

// Error Boundary Component
interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: any;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null
  };

  static getDerivedStateFromError(error: any): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: React.ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-red-50 p-4">
          <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full border border-red-100 text-center">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Something went wrong</h2>
            <p className="text-gray-600 mb-6">We encountered an unexpected error. Please try refreshing the page.</p>
            <button 
              onClick={() => window.location.reload()}
              className="w-full bg-red-600 text-white font-semibold py-3 rounded-xl hover:bg-red-700 transition-all"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }
    return (this as any).props.children;
  }
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: any;
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Helper to fix truncated JSON from Gemini
function fixTruncatedJSON(jsonString: string): string {
  let str = jsonString.trim();
  if (!str) return "[]";
  
  // Try to extract JSON from conversational text
  const firstBracket = str.indexOf('[');
  const lastBracket = str.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    str = str.substring(firstBracket, lastBracket + 1);
  } else {
    const firstBrace = str.indexOf('{');
    const lastBrace = str.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      str = str.substring(firstBrace, lastBrace + 1);
    }
  }

  try {
    JSON.parse(str);
    return str;
  } catch (e) {
    // Basic repair for common truncation patterns
    if (str.startsWith('[') && !str.endsWith(']')) {
      const lastObjEnd = str.lastIndexOf('}');
      if (lastObjEnd !== -1) {
        return str.substring(0, lastObjEnd + 1) + ']';
      }
      return str + ']';
    }
    if (str.startsWith('{') && !str.endsWith('}')) {
      return str + '}';
    }
    return str;
  }
}

function formatUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// v1.0.4 - Switched to direct REST API to fix fetch conflict and added JSON truncation fix
function LeadScraperApp() {
  const [user, setUser] = useState<User | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [savedLeads, setSavedLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchParams, setSearchParams] = useState<SearchParams>({
    query: "",
    location: "",
  });
  const [activeTab, setActiveTab] = useState<"search" | "saved" | "settings">("search");
  const [error, setError] = useState<string | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [settings, setSettings] = useState({
    autoRefresh: false,
    maxLeads: 100,
    theme: 'light'
  });
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(new Set());
  const [selectedSavedLeadIds, setSelectedSavedLeadIds] = useState<Set<string>>(new Set());
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [dbSearchQuery, setDbSearchQuery] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [page, setPage] = useState(1);
  const [geminiApiKey, setGeminiApiKey] = useState<string | null>(null);
  const [isConfigLoading, setIsConfigLoading] = useState(true);

  // Fetch API Key from server for production support
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        setIsConfigLoading(true);
        const response = await fetch("/api/config");
        
        if (!response.ok) {
          throw new Error(`Server returned ${response.status}`);
        }
        
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          const data = await response.json();
          if (data.GEMINI_API_KEY) {
            setGeminiApiKey(data.GEMINI_API_KEY);
          } else {
            console.warn("Config fetched, but GEMINI_API_KEY was empty.");
          }
        } else {
          console.error("Config endpoint returned non-JSON. The custom server might not be running.");
        }
      } catch (err) {
        console.error("Failed to fetch config:", err);
      } finally {
        setIsConfigLoading(false);
      }
    };
    fetchConfig();
  }, []);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
      if (currentUser) {
        // Sync user to Firestore
        const userRef = doc(db, 'users', currentUser.uid);
        setDoc(userRef, {
          uid: currentUser.uid,
          email: currentUser.email,
          displayName: currentUser.displayName,
          photoURL: currentUser.photoURL,
          role: 'user' // Default role
        }, { merge: true }).catch(err => console.error("Error syncing user:", err));
      }
    });
    return () => unsubscribe();
  }, []);

  // Clear selections on tab change
  useEffect(() => {
    setSelectedLeadIds(new Set());
    setSelectedSavedLeadIds(new Set());
  }, [activeTab]);

  // Firestore Real-time Listener for Leads
  useEffect(() => {
    if (!user || !isAuthReady) {
      setSavedLeads([]);
      return;
    }

    const q = query(collection(db, "leads"), where("ownerId", "==", user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const leadsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as Lead));
      setSavedLeads(leadsData);
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, "leads");
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("Login failed:", err);
      setError("Failed to sign in with Google");
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setActiveTab("search");
    } catch (err) {
      console.error("Logout failed:", err);
    }
  };

  const performSearch = async (ai: any, prompt: string, isLoadMore: boolean) => {
    let result;
    let retries = 3;
    let delay = 2000;

    while (retries > 0) {
      try {
        result = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING, description: "A unique stable ID for the business" },
                  name: { type: Type.STRING },
                  address: { type: Type.STRING },
                  phone: { type: Type.STRING },
                  website: { type: Type.STRING },
                  email: { type: Type.STRING },
                  category: { type: Type.STRING },
                  rating: { type: Type.NUMBER },
                  reviews: { type: Type.NUMBER }
                },
                required: ["name", "address", "category"]
              }
            },
            tools: [{ googleSearch: {} }]
          }
        });
        break;
      } catch (err: any) {
        const errMsg = err.message || "";
        if (errMsg.includes("503") || errMsg.includes("high demand") || errMsg.includes("UNAVAILABLE")) {
          retries--;
          if (retries === 0) throw err;
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // Exponential backoff
        } else {
          throw err;
        }
      }
    }

    if (!result) throw new Error("Failed to generate content after retries");
    const text = result.text;
    if (!text) throw new Error("No data returned from AI");
    
    const generatedLeads = JSON.parse(text);
    const processedLeads = generatedLeads.map((lead: any) => {
      const normalizedName = lead.name.toLowerCase().trim();
      const normalizedAddress = (lead.address || "").toLowerCase().trim();
      const stableId = btoa(encodeURIComponent(normalizedName + normalizedAddress)).substring(0, 24);
      
      return {
        ...lead,
        id: stableId,
        lastUpdated: new Date().toISOString()
      };
    });
    
    if (isLoadMore) {
      setLeads(prev => {
        const combined = [...prev, ...processedLeads];
        const uniqueMap = new Map();
        combined.forEach(item => uniqueMap.set(item.id, item));
        return Array.from(uniqueMap.values());
      });
    } else {
      setLeads(processedLeads);
    }
  };

  const handleSearch = async (e: React.FormEvent | null, isLoadMore = false) => {
    if (e) e.preventDefault();
    if (!searchParams.query || !searchParams.location) return;

    if (isLoadMore) {
      setPage(prev => prev + 1);
    } else {
      setPage(1);
      setLeads([]);
      setSelectedLeadIds(new Set());
    }

    setLoading(true);
    setError(null);
    try {
      const existingNames = leads.map(l => l.name).join(", ");
      const prompt = `Find as many real businesses as possible (up to ${settings.maxLeads || 50}) for the category "${searchParams.query}" in "${searchParams.location}". 
      ${isLoadMore ? `This is page ${page + 1} of the search. Please find DIFFERENT businesses than these: ${existingNames.substring(0, 1000)}...` : ""}
      Return the data as a JSON array of objects.`;

      const apiKey = geminiApiKey || "";
      if (!apiKey) {
        throw new Error("MISSING_CONFIG: The Gemini API Key was not found. Please ensure it is set in AI Studio Secrets and the server is running.");
      }
      
      const ai = new GoogleGenAI({ apiKey });
      await performSearch(ai, prompt, isLoadMore);
    } catch (err: any) {
      console.error("Search Error:", err);
      let errorMessage = "AI Search failed. Please try again later.";
      
      if (err.message?.includes("MISSING_CONFIG")) {
        errorMessage = err.message;
      } else if (err.message?.includes("503") || err.message?.includes("high demand") || err.message?.includes("UNAVAILABLE")) {
        errorMessage = "The AI service is currently overloaded. We tried 3 times but it's still busy. Please wait a minute and try again.";
      } else if (err.message?.includes("leaked")) {
        errorMessage = "Your API key has been disabled because it was leaked. Please generate a new API key in Google AI Studio and update your Secrets.";
      } else if (err.message?.includes("API key") || err.message?.includes("API_KEY")) {
        errorMessage = "The Gemini API rejected your key. Please verify your key in AI Studio Secrets is valid and active.";
      } else if (err.message) {
        errorMessage = `Error: ${err.message}`;
      }
      
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedLeadIds.size === leads.length) {
      setSelectedLeadIds(new Set());
    } else {
      setSelectedLeadIds(new Set(leads.map(l => l.id)));
    }
  };

  const toggleSelectLead = (id: string) => {
    const next = new Set(selectedLeadIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedLeadIds(next);
  };

  const handleBulkSave = async () => {
    if (!user) {
      setError("Please sign in to save leads");
      return;
    }
    if (selectedLeadIds.size === 0) return;

    setIsBulkSaving(true);
    try {
      const leadsToSave = leads.filter(l => selectedLeadIds.has(l.id));
      await Promise.all(leadsToSave.map(async (lead) => {
        const leadRef = doc(db, "leads", lead.id);
        try {
          await setDoc(leadRef, {
            ...lead,
            ownerId: user.uid,
            lastUpdated: new Date().toISOString()
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `leads/${lead.id}`);
        }
      }));
      setSelectedLeadIds(new Set());
    } catch (err: any) {
      console.error("Bulk save failed:", err);
      setError(err.message || "Failed to save some leads. Please try again.");
    } finally {
      setIsBulkSaving(false);
    }
  };

  const handleBulkDelete = async () => {
    if (!user) return;
    if (selectedSavedLeadIds.size === 0) return;

    setIsBulkDeleting(true);
    try {
      await Promise.all(Array.from(selectedSavedLeadIds).map(async (id: string) => {
        const leadRef = doc(db, "leads", id);
        try {
          await deleteDoc(leadRef);
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, `leads/${id}`);
        }
      }));
      setSelectedSavedLeadIds(new Set());
      setShowDeleteConfirm(false);
    } catch (err: any) {
      console.error("Bulk delete failed:", err);
      setError(err.message || "Failed to delete some leads. Please try again.");
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const toggleSelectAllSaved = () => {
    if (selectedSavedLeadIds.size === filteredSavedLeads.length) {
      setSelectedSavedLeadIds(new Set());
    } else {
      setSelectedSavedLeadIds(new Set(filteredSavedLeads.map(l => l.id)));
    }
  };

  const toggleSelectSavedLead = (id: string) => {
    const next = new Set(selectedSavedLeadIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedSavedLeadIds(next);
  };

  const filteredSavedLeads = savedLeads.filter(lead => {
    const search = dbSearchQuery.toLowerCase();
    return (
      lead.name.toLowerCase().includes(search) ||
      (lead.email?.toLowerCase().includes(search)) ||
      (lead.phone?.toLowerCase().includes(search)) ||
      (lead.address?.toLowerCase().includes(search)) ||
      (lead.category?.toLowerCase().includes(search))
    );
  });

  const toggleSaveLead = async (lead: Lead) => {
    if (!user) {
      setError("Please sign in to save leads");
      return;
    }

    const leadRef = doc(db, "leads", lead.id);
    const exists = savedLeads.find(l => l.id === lead.id);

    try {
      if (exists) {
        await deleteDoc(leadRef);
      } else {
        await setDoc(leadRef, {
          ...lead,
          ownerId: user.uid,
          lastUpdated: new Date().toISOString()
        });
      }
    } catch (err: any) {
      console.error("Toggle save failed:", err);
      try {
        handleFirestoreError(err, exists ? OperationType.DELETE : OperationType.WRITE, `leads/${lead.id}`);
      } catch (formattedErr: any) {
        setError(formattedErr.message);
      }
    }
  };

  const handleRefreshLeads = async () => {
    if (savedLeads.length === 0) return;
    setRefreshing(true);
    try {
      const prompt = `Update the information for these businesses: ${savedLeads.map(l => l.name).join(", ")}. 
      Return the updated data as a JSON array of objects with the same fields as before (id, name, address, phone, website, email, category, rating, reviews).
      IMPORTANT: Return ONLY the JSON array. Do not include any conversational text, explanations, or markdown formatting. Start your response with '[' and end with ']'.`;

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ googleSearch: {} }]
        })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error?.message || "Gemini API request failed");
      }

      const result = await response.json();
      let text = result.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
      
      // Remove markdown code blocks if present
      if (text.includes("```json")) {
        text = text.split("```json")[1].split("```")[0].trim();
      } else if (text.includes("```")) {
        text = text.split("```")[1].split("```")[0].trim();
      }
      
      text = fixTruncatedJSON(text);
      const updatedLeads = JSON.parse(text);
      
      await Promise.all(updatedLeads.map(async (lead: any) => {
        const leadRef = doc(db, "leads", lead.id || lead.name.replace(/\s+/g, '-').toLowerCase());
        return setDoc(leadRef, { 
          ...lead, 
          ownerId: user?.uid,
          lastUpdated: new Date().toISOString()
        }, { merge: true });
      }));
    } catch (err: any) {
      console.error("Refresh failed", err);
      setError(err.message || "Failed to refresh leads");
    } finally {
      setRefreshing(false);
    }
  };

  const exportToCSV = (data: Lead[]) => {
    const csv = Papa.unparse(data);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    
    // Dynamic filename based on search params
    const query = searchParams.query.replace(/\s+/g, '_') || 'leads';
    const location = searchParams.location.replace(/\s+/g, '_') || 'global';
    const filename = `${query}_${location}_${new Date().toISOString().split('T')[0]}.csv`;
    
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const isSaved = (id: string) => savedLeads.some(l => l.id === id);

  if (!isAuthReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8F9FA]">
        <RefreshCw className="w-8 h-8 text-[#2563EB] animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans">
      {/* Sidebar */}
      <aside className="fixed left-0 top-0 h-full w-64 bg-white border-r border-[#E5E7EB] z-20 hidden md:block">
        <div className="p-6 border-bottom border-[#E5E7EB]">
          <div className="flex items-center gap-2 text-[#2563EB]">
            <Database className="w-8 h-8" />
            <span className="text-xl font-bold tracking-tight">MapLead Pro</span>
          </div>
        </div>
        
        <nav className="p-4 space-y-2">
          <button 
            onClick={() => setActiveTab("search")}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200",
              activeTab === "search" ? "bg-[#EFF6FF] text-[#2563EB] font-medium" : "text-[#6B7280] hover:bg-[#F3F4F6]"
            )}
          >
            <Search className="w-5 h-5" />
            Find Leads
          </button>
          <button 
            onClick={() => {
              if (!user) {
                setError("Please sign in to view your database");
                return;
              }
              setActiveTab("saved");
            }}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200",
              activeTab === "saved" ? "bg-[#EFF6FF] text-[#2563EB] font-medium" : "text-[#6B7280] hover:bg-[#F3F4F6]"
            )}
          >
            <LayoutDashboard className="w-5 h-5" />
            My Database
            {savedLeads.length > 0 && (
              <span className="ml-auto bg-[#2563EB] text-white text-[10px] px-2 py-0.5 rounded-full">
                {savedLeads.length}
              </span>
            )}
          </button>
          <div className="pt-4 mt-4 border-t border-[#F3F4F6]">
            <button 
              onClick={() => setActiveTab("settings")}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200",
                activeTab === "settings" ? "bg-[#EFF6FF] text-[#2563EB] font-medium" : "text-[#6B7280] hover:bg-[#F3F4F6]"
              )}
            >
              <SettingsIcon className="w-5 h-5" />
              Settings
            </button>
          </div>
        </nav>

        <div className="absolute bottom-0 left-0 w-full p-4">
          {user ? (
            <div className="bg-[#F3F4F6] rounded-2xl p-4">
              <div className="flex items-center gap-3 mb-3">
                <img src={user.photoURL || ""} alt="" className="w-10 h-10 rounded-full border-2 border-white shadow-sm" referrerPolicy="no-referrer" />
                <div className="overflow-hidden">
                  <p className="text-sm font-bold text-[#111827] truncate">{user.displayName}</p>
                  <p className="text-[10px] text-[#6B7280] truncate">{user.email}</p>
                </div>
              </div>
              <button 
                onClick={handleLogout}
                className="w-full flex items-center justify-center gap-2 py-2 bg-white border border-[#E5E7EB] rounded-xl text-xs font-semibold text-[#EF4444] hover:bg-red-50 transition-all"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign Out
              </button>
            </div>
          ) : (
            <button 
              onClick={handleLogin}
              className="w-full flex items-center justify-center gap-2 py-3 bg-[#2563EB] text-white rounded-xl font-bold hover:bg-[#1D4ED8] transition-all shadow-lg shadow-blue-500/20"
            >
              <LogIn className="w-5 h-5" />
              Sign In with Google
            </button>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="md:ml-64 min-h-screen bg-[#F9FAFB]">
        {/* Sticky Top Section */}
        <div className="sticky top-0 z-40 bg-[#F9FAFB]/95 backdrop-blur-sm border-b border-[#E5E7EB] p-4 md:p-8 pb-4">
          <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-2xl md:text-3xl font-bold text-[#111827]">
                  {activeTab === "search" ? "Lead Finder" : activeTab === "saved" ? "My Lead Database" : "Settings"}
                </h1>
                {activeTab === "search" && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-[#2563EB] text-[10px] font-bold uppercase tracking-wider border border-blue-100">
                    <Sparkles className="w-3 h-3" />
                    AI Powered
                  </span>
                )}
              </div>
              <p className="text-[#6B7280] text-sm md:text-base max-w-2xl mt-1">
                {activeTab === "search" 
                  ? "Target specific business categories and locations. Extract names, phones, emails, and more directly from Google Maps data." 
                  : activeTab === "saved" 
                  ? `Manage and export your collected business leads. Total: ${savedLeads.length}`
                  : "Configure your application preferences."}
              </p>
            </div>
            
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-3">
                {activeTab === "saved" && savedLeads.length > 0 && (
                  <button 
                    onClick={handleRefreshLeads}
                    disabled={refreshing}
                    className="flex items-center gap-2 px-4 py-2.5 bg-[#EFF6FF] border border-[#DBEAFE] rounded-xl text-sm font-medium text-[#2563EB] hover:bg-[#DBEAFE] transition-all duration-200 disabled:opacity-50"
                  >
                    <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
                    Refresh All
                  </button>
                )}
                <button 
                  onClick={() => exportToCSV(activeTab === "search" ? leads : savedLeads)}
                  disabled={(activeTab === "search" ? leads : savedLeads).length === 0}
                  className="flex items-center gap-2 px-4 py-2.5 bg-white border border-[#E5E7EB] rounded-xl text-sm font-medium text-[#374151] hover:bg-[#F9FAFB] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                >
                  <Download className="w-4 h-4" />
                  Export CSV
                </button>
              </div>
              {(activeTab === "search" || activeTab === "saved") && (
                <div className="flex items-center gap-1.5 px-3 py-1 bg-blue-50/50 border border-blue-100 rounded-lg">
                  <span className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">
                    Total Leads:
                  </span>
                  <span className="text-xs font-bold text-[#2563EB]">
                    {activeTab === "search" ? leads.length : savedLeads.length}
                  </span>
                </div>
              )}
            </div>
          </header>

          {activeTab === "search" && (
            <div className="space-y-4">
              <form onSubmit={handleSearch} className="bg-white p-4 rounded-2xl border border-[#E5E7EB] shadow-sm">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#9CA3AF]" />
                    <input 
                      type="text"
                      placeholder="What are you looking for? (e.g. Plumbers)"
                      className="w-full pl-12 pr-4 py-3 bg-[#F9FAFB] border border-[#E5E7EB] rounded-xl focus:ring-2 focus:ring-[#2563EB] focus:border-transparent outline-none transition-all duration-200"
                      value={searchParams.query}
                      onChange={(e) => setSearchParams(prev => ({ ...prev, query: e.target.value }))}
                    />
                  </div>
                  <div className="relative">
                    <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#9CA3AF]" />
                    <input 
                      type="text"
                      placeholder="Location (e.g. New York, NY)"
                      className="w-full pl-12 pr-4 py-3 bg-[#F9FAFB] border border-[#E5E7EB] rounded-xl focus:ring-2 focus:ring-[#2563EB] focus:border-transparent outline-none transition-all duration-200"
                      value={searchParams.location}
                      onChange={(e) => setSearchParams(prev => ({ ...prev, location: e.target.value }))}
                    />
                  </div>
                  <button 
                    type="submit"
                    disabled={loading || !searchParams.query || !searchParams.location}
                    className="bg-[#2563EB] text-white font-semibold py-3 px-6 rounded-xl hover:bg-[#1D4ED8] transition-all duration-200 disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20"
                  >
                    {loading ? <RefreshCw className="w-5 h-5 animate-spin" /> : "AI Search Leads"}
                  </button>
                </div>
              </form>

              {/* Bulk Actions for Search */}
              {selectedLeadIds.size > 0 && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center justify-between bg-[#2563EB] text-white p-4 rounded-2xl shadow-lg"
                >
                  <div className="flex items-center gap-4">
                    <CheckCircle2 className="w-6 h-6" />
                    <span className="font-semibold">{selectedLeadIds.size} leads selected</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={() => setSelectedLeadIds(new Set())}
                      className="text-white/80 hover:text-white text-sm font-medium px-3 py-1"
                    >
                      Deselect All
                    </button>
                    <button 
                      onClick={handleBulkSave}
                      disabled={isBulkSaving}
                      className="bg-white text-[#2563EB] px-6 py-2 rounded-xl font-bold hover:bg-blue-50 transition-all flex items-center gap-2 disabled:opacity-50 shadow-md"
                    >
                      {isBulkSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
                      Save Selected to Database
                    </button>
                  </div>
                </motion.div>
              )}
            </div>
          )}

          {activeTab === "saved" && (
            <div className="space-y-4">
              <div className="bg-white p-4 rounded-2xl border border-[#E5E7EB] shadow-sm">
                <div className="relative">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#9CA3AF]" />
                  <input 
                    type="text"
                    placeholder="Search your database by name, email, phone, or category..."
                    className="w-full pl-12 pr-4 py-3 bg-[#F9FAFB] border border-[#E5E7EB] rounded-xl focus:ring-2 focus:ring-[#2563EB] focus:border-transparent outline-none transition-all duration-200"
                    value={dbSearchQuery}
                    onChange={(e) => setDbSearchQuery(e.target.value)}
                  />
                </div>
              </div>

              {/* Bulk Actions for Database */}
              {selectedSavedLeadIds.size > 0 && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center justify-between bg-[#EF4444] text-white p-4 rounded-2xl shadow-lg"
                >
                  <div className="flex items-center gap-4">
                    <Trash2 className="w-6 h-6" />
                    <span className="font-semibold">{selectedSavedLeadIds.size} leads selected for deletion</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={() => setSelectedSavedLeadIds(new Set())}
                      className="text-white/80 hover:text-white text-sm font-medium px-3 py-1"
                    >
                      Deselect All
                    </button>
                    {showDeleteConfirm ? (
                      <>
                        <button 
                          onClick={() => setShowDeleteConfirm(false)}
                          className="px-4 py-2 rounded-xl font-bold hover:bg-white/10 transition-all text-sm"
                        >
                          Cancel
                        </button>
                        <button 
                          onClick={handleBulkDelete}
                          disabled={isBulkDeleting}
                          className="bg-white text-[#EF4444] px-6 py-2 rounded-xl font-bold hover:bg-red-50 transition-all flex items-center gap-2 disabled:opacity-50 shadow-md"
                        >
                          {isBulkDeleting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                          Confirm Delete
                        </button>
                      </>
                    ) : (
                      <button 
                        onClick={() => setShowDeleteConfirm(true)}
                        className="bg-white text-[#EF4444] px-6 py-2 rounded-xl font-bold hover:bg-red-50 transition-all flex items-center gap-2 shadow-md"
                      >
                        <Trash2 className="w-4 h-4" />
                        Delete Selected
                      </button>
                    )}
                  </div>
                </motion.div>
              )}
            </div>
          )}
        </div>

        <div className="p-4 md:p-8 pt-6">
          {activeTab === "search" && (
            <div className="space-y-6">
              {error && (
                <div className="bg-red-50 border border-red-100 text-red-600 px-4 py-3 rounded-xl flex items-center gap-3">
                  <AlertCircle className="w-5 h-5" />
                  <p className="text-sm font-medium">{error}</p>
                  <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600">×</button>
                </div>
              )}

              {/* Results */}
              <div className="bg-white rounded-2xl border border-[#E5E7EB] overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-[#F9FAFB] border-b border-[#E5E7EB]">
                      <th className="px-6 py-4 w-10">
                        <input 
                          type="checkbox" 
                          className="w-4 h-4 rounded border-gray-300 text-[#2563EB] focus:ring-[#2563EB]"
                          checked={leads.length > 0 && selectedLeadIds.size === leads.length}
                          onChange={toggleSelectAll}
                        />
                      </th>
                      <th className="px-6 py-4 text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Business Name</th>
                      <th className="px-6 py-4 text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Contact Info</th>
                      <th className="px-6 py-4 text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Category & Rating</th>
                      <th className="px-6 py-4 text-xs font-semibold text-[#6B7280] uppercase tracking-wider text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F3F4F6]">
                    <AnimatePresence mode="popLayout">
                      {leads.length === 0 && !loading && (
                        <tr>
                          <td colSpan={4} className="px-6 py-12 text-center text-[#9CA3AF]">
                            <div className="flex flex-col items-center gap-2">
                              <Search className="w-12 h-12 opacity-20" />
                              <p>No results found. Start a new search above.</p>
                            </div>
                          </td>
                        </tr>
                      )}
                      {leads.map((lead) => (
                        <motion.tr 
                          key={lead.id}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className={cn(
                            "hover:bg-[#F9FAFB] transition-colors duration-150 group",
                            selectedLeadIds.has(lead.id) && "bg-blue-50/50"
                          )}
                        >
                          <td className="px-6 py-4">
                            <input 
                              type="checkbox" 
                              className="w-4 h-4 rounded border-gray-300 text-[#2563EB] focus:ring-[#2563EB]"
                              checked={selectedLeadIds.has(lead.id)}
                              onChange={() => toggleSelectLead(lead.id)}
                            />
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-col">
                              <span className="font-semibold text-[#111827]">{lead.name}</span>
                              <span className="text-xs text-[#6B7280] flex items-center gap-1 mt-1">
                                <MapPin className="w-3 h-3" />
                                {lead.address}
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-col gap-1.5">
                              {lead.phone && (
                                <span className="text-xs text-[#374151] flex items-center gap-1.5">
                                  <Phone className="w-3.5 h-3.5 text-[#2563EB]" />
                                  {lead.phone}
                                </span>
                              )}
                              {lead.email && (
                                <span className="text-xs text-[#374151] flex items-center gap-1.5">
                                  <Mail className="w-3.5 h-3.5 text-[#2563EB]" />
                                  {lead.email}
                                </span>
                              )}
                              {lead.website && (
                                <a 
                                  href={lead.website} 
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  className="text-xs text-[#2563EB] hover:underline flex items-center gap-1.5 truncate max-w-[200px]"
                                  title={lead.website}
                                >
                                  <Globe className="w-3.5 h-3.5 shrink-0" />
                                  <span className="truncate">{formatUrl(lead.website)}</span>
                                  <ExternalLink className="w-3 h-3 shrink-0" />
                                </a>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-col gap-1.5">
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-[#F3F4F6] text-[#4B5563] w-fit uppercase tracking-wider">
                                {lead.category}
                              </span>
                              <div className="flex items-center gap-1 text-xs text-[#374151]">
                                <Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400" />
                                <span className="font-medium">{lead.rating}</span>
                                <span className="text-[#9CA3AF]">({lead.reviews} reviews)</span>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <button 
                              onClick={() => toggleSaveLead(lead)}
                              className={cn(
                                "p-2 rounded-lg transition-all duration-200",
                                isSaved(lead.id) 
                                  ? "bg-[#2563EB] text-white shadow-md shadow-blue-500/20" 
                                  : "bg-[#F3F4F6] text-[#6B7280] hover:bg-[#E5E7EB] hover:text-[#374151]"
                              )}
                            >
                              {isSaved(lead.id) ? <CheckCircle2 className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                            </button>
                          </td>
                        </motion.tr>
                      ))}
                    </AnimatePresence>
                  </tbody>
                </table>
              </div>
              
              {leads.length > 0 && (
                <div className="p-6 border-t border-[#F3F4F6] flex justify-center">
                  <button 
                    onClick={() => handleSearch(null, true)}
                    disabled={loading}
                    className="flex items-center gap-2 px-8 py-3 bg-white border border-[#E5E7EB] rounded-xl text-sm font-bold text-[#2563EB] hover:bg-[#F9FAFB] transition-all shadow-sm disabled:opacity-50"
                  >
                    {loading ? <RefreshCw className="w-5 h-5 animate-spin" /> : <ChevronRight className="w-5 h-5 rotate-90" />}
                    Load More Leads for this Location
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "saved" && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-[#E5E7EB] overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-[#F9FAFB] border-b border-[#E5E7EB]">
                      <th className="px-6 py-4 w-10">
                        <input 
                          type="checkbox" 
                          className="w-4 h-4 rounded border-gray-300 text-[#2563EB] focus:ring-[#2563EB]"
                          checked={filteredSavedLeads.length > 0 && selectedSavedLeadIds.size === filteredSavedLeads.length}
                          onChange={toggleSelectAllSaved}
                        />
                      </th>
                      <th className="px-6 py-4 text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Lead Details</th>
                      <th className="px-6 py-4 text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Contact</th>
                      <th className="px-6 py-4 text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Last Sync</th>
                      <th className="px-6 py-4 text-xs font-semibold text-[#6B7280] uppercase tracking-wider text-right">Manage</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F3F4F6]">
                    {filteredSavedLeads.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-6 py-12 text-center text-[#9CA3AF]">
                          <div className="flex flex-col items-center gap-2">
                            <Database className="w-12 h-12 opacity-20" />
                            <p>{dbSearchQuery ? "No leads match your search." : "Your database is empty. Save some leads from the search tab."}</p>
                          </div>
                        </td>
                      </tr>
                    )}
                    {filteredSavedLeads.map((lead) => (
                      <tr 
                        key={lead.id} 
                        className={cn(
                          "hover:bg-[#F9FAFB] transition-colors duration-150",
                          selectedSavedLeadIds.has(lead.id) && "bg-red-50/30"
                        )}
                      >
                        <td className="px-6 py-4">
                          <input 
                            type="checkbox" 
                            className="w-4 h-4 rounded border-gray-300 text-[#2563EB] focus:ring-[#2563EB]"
                            checked={selectedSavedLeadIds.has(lead.id)}
                            onChange={() => toggleSelectSavedLead(lead.id)}
                          />
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-col">
                            <span className="font-semibold text-[#111827]">{lead.name}</span>
                            <span className="text-xs text-[#6B7280] mt-0.5">{lead.address}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-col gap-1">
                            {lead.phone && <span className="text-xs text-[#374151]">{lead.phone}</span>}
                            {lead.email && <span className="text-xs text-[#2563EB]">{lead.email}</span>}
                            {lead.website && (
                              <a 
                                href={lead.website} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-[10px] text-[#2563EB] hover:underline truncate max-w-[150px]"
                                title={lead.website}
                              >
                                {formatUrl(lead.website)}
                              </a>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-xs text-[#6B7280]">
                            {new Date(lead.lastUpdated).toLocaleDateString()}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button 
                              onClick={() => toggleSaveLead(lead)}
                              className="p-2 text-[#6B7280] hover:text-[#2563EB] hover:bg-[#EFF6FF] rounded-lg transition-all"
                            >
                              <RefreshCw className="w-4 h-4" />
                            </button>
                            <button 
                              onClick={() => toggleSaveLead(lead)}
                              className="p-2 text-[#6B7280] hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
        {activeTab === "settings" && (
          <div className="max-w-2xl space-y-6">
            <div className="bg-white p-8 rounded-2xl border border-[#E5E7EB] shadow-sm">
              <h2 className="text-lg font-bold text-[#111827] mb-6 flex items-center gap-2">
                <SettingsIcon className="w-5 h-5 text-[#2563EB]" />
                Application Settings
              </h2>
              
              <div className="space-y-6">
                <div className="flex items-center justify-between p-4 bg-[#F9FAFB] rounded-xl border border-[#E5E7EB]">
                  <div>
                    <p className="font-semibold text-[#374151]">Max Leads per Search</p>
                    <p className="text-xs text-[#6B7280]">Higher numbers may take longer to process.</p>
                  </div>
                  <select 
                    value={settings.maxLeads}
                    onChange={(e) => setSettings(prev => ({ ...prev, maxLeads: Number(e.target.value) }))}
                    className="bg-white border border-[#E5E7EB] rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#2563EB]"
                  >
                    <option value={10}>10 Leads</option>
                    <option value={20}>20 Leads</option>
                    <option value={50}>50 Leads</option>
                    <option value={100}>100 Leads</option>
                  </select>
                </div>

                <div className="flex items-center justify-between p-4 bg-[#F9FAFB] rounded-xl border border-[#E5E7EB]">
                  <div>
                    <p className="font-semibold text-[#374151]">Auto-Refresh Data</p>
                    <p className="text-xs text-[#6B7280]">Automatically update lead info when viewing database.</p>
                  </div>
                  <button 
                    onClick={() => setSettings(prev => ({ ...prev, autoRefresh: !prev.autoRefresh }))}
                    className={cn(
                      "w-12 h-6 rounded-full transition-all duration-200 relative",
                      settings.autoRefresh ? "bg-[#2563EB]" : "bg-[#D1D5DB]"
                    )}
                  >
                    <div className={cn(
                      "absolute top-1 w-4 h-4 bg-white rounded-full transition-all duration-200",
                      settings.autoRefresh ? "left-7" : "left-1"
                    )} />
                  </button>
                </div>

                <div className="p-4 bg-blue-50 rounded-xl border border-blue-100">
                  <div className="flex gap-3">
                    <AlertCircle className="w-5 h-5 text-[#2563EB] shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-[#1E40AF]">About 1000 Leads</p>
                      <p className="text-xs text-[#3B82F6] mt-1 leading-relaxed">
                        Generating 1000 leads in a single request is limited by AI output constraints. 
                        We recommend searching for specific categories or locations to get the most accurate results. 
                        You can increase the limit to 100 per search in settings.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <LeadScraperApp />
    </ErrorBoundary>
  );
}
