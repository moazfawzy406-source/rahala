import React from 'react';
import {
  AlarmClock,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BarChart3,
  Bell,
  BellRing,
  BookOpen,
  Check,
  CheckCheck,
  CheckCircle2,
  Clock,
  ChevronDown,
  ChevronLeft,
  Columns2,
  Compass,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  Feather,
  FileText,
  FolderPlus,
  Hand,
  Headphones,
  Image as ImageIcon,
  Info,
  Landmark,
  Layers,
  LayoutGrid,
  Link2,
  Lock,
  LogOut,
  Maximize2,
  Mic,
  Minimize2,
  Monitor,
  MoreVertical,
  Palette,
  Paperclip,
  Pause,
  PhoneOff,
  Pin,
  PinOff,
  Play,
  Plus,
  Reply,
  RotateCcw,
  ScrollText,
  Search,
  Send,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Smile,
  Sparkles,
  Square,
  Star,
  Trash2,
  Trophy,
  Type,
  Unlock,
  Upload,
  User,
  UserCheck,
  UserPlus,
  Users,
  UserX,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  MicOff,
  X,
  MessageSquare,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';

export function RahhalaBookMark({ className = 'w-7 h-7' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 36 36"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M5.5 9.5C5.5 7.84315 6.84315 6.5 8.5 6.5H15C16.6569 6.5 18 7.84315 18 9.5V29C18 27.6193 16.8807 26.5 15.5 26.5H8.5C6.84315 26.5 5.5 25.1569 5.5 23.5V9.5Z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M30.5 9.5C30.5 7.84315 29.1569 6.5 27.5 6.5H21C19.3431 6.5 18 7.84315 18 9.5V29C18 27.6193 19.1193 26.5 20.5 26.5H27.5C29.1569 26.5 30.5 25.1569 30.5 23.5V9.5Z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 12.5H14M9.5 17H14M22 12.5H26.5M22 17H26.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SubjectIcon({ name, className = 'w-5 h-5' }: { name: string; className?: string }) {
  const props = { className, strokeWidth: 1.8, 'aria-hidden': true as const };
  switch (name) {
    case 'feather':
      return <Feather {...props} />;
    case 'scroll':
      return <ScrollText {...props} />;
    case 'landmark':
      return <Landmark {...props} />;
    case 'compass':
      return <Compass {...props} />;
    case 'layers':
      return <Layers {...props} />;
    default:
      return <BookOpen {...props} />;
  }
}

export const Icons = {
  AlarmClock: (p: { className?: string }) => <AlarmClock strokeWidth={1.8} aria-hidden="true" {...p} />,
  ArrowDown: (p: { className?: string }) => <ArrowDown strokeWidth={1.8} aria-hidden="true" {...p} />,
  ArrowRight: (p: { className?: string }) => <ArrowRight strokeWidth={1.8} aria-hidden="true" {...p} />,
  ArrowUp: (p: { className?: string }) => <ArrowUp strokeWidth={1.8} aria-hidden="true" {...p} />,
  BarChart: (p: { className?: string }) => <BarChart3 strokeWidth={1.8} aria-hidden="true" {...p} />,
  Bell: (p: { className?: string }) => <Bell strokeWidth={1.8} aria-hidden="true" {...p} />,
  BellRing: (p: { className?: string }) => <BellRing strokeWidth={1.8} aria-hidden="true" {...p} />,
  BookOpen: (p: { className?: string }) => <BookOpen strokeWidth={1.8} aria-hidden="true" {...p} />,
  Check: (p: { className?: string }) => <Check strokeWidth={1.8} aria-hidden="true" {...p} />,
  CheckCheck: (p: { className?: string }) => <CheckCheck strokeWidth={1.8} aria-hidden="true" {...p} />,
  CheckCircle: (p: { className?: string }) => <CheckCircle2 strokeWidth={1.8} aria-hidden="true" {...p} />,
  Clock: (p: { className?: string }) => <Clock strokeWidth={1.8} aria-hidden="true" {...p} />,
  ChevronDown: (p: { className?: string }) => <ChevronDown strokeWidth={1.8} aria-hidden="true" {...p} />,
  ChevronLeft: (p: { className?: string }) => <ChevronLeft strokeWidth={1.8} aria-hidden="true" {...p} />,
  Columns: (p: { className?: string }) => <Columns2 strokeWidth={1.8} aria-hidden="true" {...p} />,
  Copy: (p: { className?: string }) => <Copy strokeWidth={1.8} aria-hidden="true" {...p} />,
  Download: (p: { className?: string }) => <Download strokeWidth={1.8} aria-hidden="true" {...p} />,
  Edit: (p: { className?: string }) => <Edit3 strokeWidth={1.8} aria-hidden="true" {...p} />,
  ExternalLink: (p: { className?: string }) => <ExternalLink strokeWidth={1.8} aria-hidden="true" {...p} />,
  Eye: (p: { className?: string }) => <Eye strokeWidth={1.8} aria-hidden="true" {...p} />,
  EyeOff: (p: { className?: string }) => <EyeOff strokeWidth={1.8} aria-hidden="true" {...p} />,
  FileText: (p: { className?: string }) => <FileText strokeWidth={1.8} aria-hidden="true" {...p} />,
  FolderPlus: (p: { className?: string }) => <FolderPlus strokeWidth={1.8} aria-hidden="true" {...p} />,
  Hand: (p: { className?: string }) => <Hand strokeWidth={1.8} aria-hidden="true" {...p} />,
  Headphones: (p: { className?: string }) => <Headphones strokeWidth={1.8} aria-hidden="true" {...p} />,
  Image: (p: { className?: string }) => <ImageIcon strokeWidth={1.8} aria-hidden="true" {...p} />,
  Info: (p: { className?: string }) => <Info strokeWidth={1.8} aria-hidden="true" {...p} />,
  LayoutGrid: (p: { className?: string }) => <LayoutGrid strokeWidth={1.8} aria-hidden="true" {...p} />,
  Link: (p: { className?: string }) => <Link2 strokeWidth={1.8} aria-hidden="true" {...p} />,
  Lock: (p: { className?: string }) => <Lock strokeWidth={1.8} aria-hidden="true" {...p} />,
  LogOut: (p: { className?: string }) => <LogOut strokeWidth={1.8} aria-hidden="true" {...p} />,
  Maximize: (p: { className?: string }) => <Maximize2 strokeWidth={1.8} aria-hidden="true" {...p} />,
  MessageSquare: (p: { className?: string }) => <MessageSquare strokeWidth={1.8} aria-hidden="true" {...p} />,
  Mic: (p: { className?: string }) => <Mic strokeWidth={1.8} aria-hidden="true" {...p} />,
  MicOff: (p: { className?: string }) => <MicOff strokeWidth={1.8} aria-hidden="true" {...p} />,
  Minimize: (p: { className?: string }) => <Minimize2 strokeWidth={1.8} aria-hidden="true" {...p} />,
  Monitor: (p: { className?: string }) => <Monitor strokeWidth={1.8} aria-hidden="true" {...p} />,
  MoreVertical: (p: { className?: string }) => <MoreVertical strokeWidth={1.8} aria-hidden="true" {...p} />,
  Palette: (p: { className?: string }) => <Palette strokeWidth={1.8} aria-hidden="true" {...p} />,
  Paperclip: (p: { className?: string }) => <Paperclip strokeWidth={1.8} aria-hidden="true" {...p} />,
  Pause: (p: { className?: string }) => <Pause strokeWidth={1.8} aria-hidden="true" {...p} />,
  PhoneOff: (p: { className?: string }) => <PhoneOff strokeWidth={1.8} aria-hidden="true" {...p} />,
  Pin: (p: { className?: string }) => <Pin strokeWidth={1.8} aria-hidden="true" {...p} />,
  PinOff: (p: { className?: string }) => <PinOff strokeWidth={1.8} aria-hidden="true" {...p} />,
  Play: (p: { className?: string }) => <Play strokeWidth={1.8} aria-hidden="true" {...p} />,
  Plus: (p: { className?: string }) => <Plus strokeWidth={1.8} aria-hidden="true" {...p} />,
  Refresh: (p: { className?: string }) => <RefreshCw strokeWidth={1.8} aria-hidden="true" {...p} />,
  Reply: (p: { className?: string }) => <Reply strokeWidth={1.8} aria-hidden="true" {...p} />,
  RotateCcw: (p: { className?: string }) => <RotateCcw strokeWidth={1.8} aria-hidden="true" {...p} />,
  Search: (p: { className?: string }) => <Search strokeWidth={1.8} aria-hidden="true" {...p} />,
  Send: (p: { className?: string }) => <Send strokeWidth={1.8} aria-hidden="true" {...p} />,
  Settings: (p: { className?: string }) => <Settings strokeWidth={1.8} aria-hidden="true" {...p} />,
  Shield: (p: { className?: string }) => <Shield strokeWidth={1.8} aria-hidden="true" {...p} />,
  ShieldCheck: (p: { className?: string }) => <ShieldCheck strokeWidth={1.8} aria-hidden="true" {...p} />,
  Sliders: (p: { className?: string }) => <SlidersHorizontal strokeWidth={1.8} aria-hidden="true" {...p} />,
  Smile: (p: { className?: string }) => <Smile strokeWidth={1.8} aria-hidden="true" {...p} />,
  Sparkles: (p: { className?: string }) => <Sparkles strokeWidth={1.8} aria-hidden="true" {...p} />,
  Square: (p: { className?: string }) => <Square strokeWidth={1.8} aria-hidden="true" {...p} />,
  Star: (p: { className?: string }) => <Star strokeWidth={1.8} aria-hidden="true" {...p} />,
  Trash: (p: { className?: string }) => <Trash2 strokeWidth={1.8} aria-hidden="true" {...p} />,
  Trophy: (p: { className?: string }) => <Trophy strokeWidth={1.8} aria-hidden="true" {...p} />,
  Type: (p: { className?: string }) => <Type strokeWidth={1.8} aria-hidden="true" {...p} />,
  Unlock: (p: { className?: string }) => <Unlock strokeWidth={1.8} aria-hidden="true" {...p} />,
  Upload: (p: { className?: string }) => <Upload strokeWidth={1.8} aria-hidden="true" {...p} />,
  User: (p: { className?: string }) => <User strokeWidth={1.8} aria-hidden="true" {...p} />,
  UserCheck: (p: { className?: string }) => <UserCheck strokeWidth={1.8} aria-hidden="true" {...p} />,
  UserPlus: (p: { className?: string }) => <UserPlus strokeWidth={1.8} aria-hidden="true" {...p} />,
  Users: (p: { className?: string }) => <Users strokeWidth={1.8} aria-hidden="true" {...p} />,
  UserX: (p: { className?: string }) => <UserX strokeWidth={1.8} aria-hidden="true" {...p} />,
  Video: (p: { className?: string }) => <Video strokeWidth={1.8} aria-hidden="true" {...p} />,
  VideoOff: (p: { className?: string }) => <VideoOff strokeWidth={1.8} aria-hidden="true" {...p} />,
  Volume2: (p: { className?: string }) => <Volume2 strokeWidth={1.8} aria-hidden="true" {...p} />,
  VolumeX: (p: { className?: string }) => <VolumeX strokeWidth={1.8} aria-hidden="true" {...p} />,
  AlertCircle: (p: { className?: string }) => <AlertCircle strokeWidth={1.8} aria-hidden="true" {...p} />,
  X: (p: { className?: string }) => <X strokeWidth={1.8} aria-hidden="true" {...p} />,
};
