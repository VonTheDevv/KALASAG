import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Image as ImageIcon, Loader2, MapPin, Send, WifiOff, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { getDevicePosition } from '../lib/deviceGeolocation'
import { Button, IconButton, Input, Panel, Select, Skeleton } from './ui/primitives'

type Family = { id: string; name: string; host_id: string }
type Message = {
  id: string
  family_id: string
  user_id: string
  first_name: string
  content: string
  message_type: 'text' | 'status_update' | 'media' | 'location'
  created_at: string
  media_path?: string | null
  media_url?: string | null
  latitude?: number | null
  longitude?: number | null
}
type OutboundMessage = Pick<Message, 'family_id' | 'content' | 'message_type'> &
  Partial<Pick<Message, 'media_path' | 'latitude' | 'longitude'>>

const CHAT_HISTORY_LIMIT = 100
const MAX_VISIBLE_MESSAGES = 200
const MAX_MESSAGE_LENGTH = 1_000
const SIGNED_MEDIA_TTL_SECONDS = 60 * 60
const ALLOWED_MEDIA_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
])

const isVideo = (url: string) => /\.(mp4|webm|ogg)(\?|$)/i.test(url)
const isValidCoordinate = (latitude: number, longitude: number) =>
  Number.isFinite(latitude) && Number.isFinite(longitude) &&
  latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180

function keepLatestMessages(messages: Message[]) {
  return messages.length > MAX_VISIBLE_MESSAGES ? messages.slice(-MAX_VISIBLE_MESSAGES) : messages
}

export default function FamilyChat({ onBack }: { onBack: () => void }) {
  const { user } = useAuth()
  const isOnline = useOnlineStatus()
  const [families, setFamilies] = useState<Family[]>([])
  const [family, setFamily] = useState<Family | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const hydrateMessage = useCallback(async (message: Message): Promise<Message> => {
    if (message.message_type !== 'media' || !message.media_path) return message
    const { data } = await supabase.storage.from('chat_media').createSignedUrl(message.media_path, SIGNED_MEDIA_TTL_SECONDS)
    return { ...message, media_url: data?.signedUrl ?? null }
  }, [])

  const hydrateMessages = useCallback(async (messageList: Message[]): Promise<Message[]> => {
    const paths = [...new Set(messageList.flatMap(message =>
      message.message_type === 'media' && message.media_path ? [message.media_path] : [],
    ))]
    if (paths.length === 0) return messageList

    const { data, error: signingError } = await supabase.storage
      .from('chat_media')
      .createSignedUrls(paths, SIGNED_MEDIA_TTL_SECONDS)
    if (signingError || !data) return messageList

    const signedUrls = new Map(data.flatMap(result =>
      result.path && result.signedUrl ? [[result.path, result.signedUrl] as const] : [],
    ))
    return messageList.map(message => ({
      ...message,
      media_url: message.media_path ? signedUrls.get(message.media_path) ?? null : message.media_url,
    }))
  }, [])

  const loadMessages = useCallback(async (familyId: string) => {
    const { data, error: loadError } = await supabase
      .from('family_messages')
      .select('id, family_id, user_id, first_name, content, message_type, created_at, media_path, latitude, longitude')
      .eq('family_id', familyId)
      .order('created_at', { ascending: false })
      .limit(CHAT_HISTORY_LIMIT)
    if (loadError) throw loadError
    const latestMessages = ((data ?? []) as Message[]).reverse()
    setMessages(await hydrateMessages(latestMessages))
  }, [hydrateMessages])

  const loadFamilies = useCallback(async () => {
    if (!user) return
    setLoading(true)
    try {
      const [{ data: hosted, error: hostedError }, { data: memberships, error: membershipError }] = await Promise.all([
        supabase.from('families').select('id, name, host_id').eq('host_id', user.id).order('created_at', { ascending: true }),
        supabase.from('family_members').select('families(id, name, host_id)').eq('user_id', user.id).eq('status', 'approved'),
      ])
      if (hostedError) throw hostedError
      if (membershipError) throw membershipError

      const approvedFamilies = (memberships ?? []) as Array<{ families: Family | Family[] | null }>
      const available = [
        ...((hosted ?? []) as Family[]),
        ...approvedFamilies.flatMap(row => !row.families ? [] : Array.isArray(row.families) ? row.families : [row.families]),
      ].filter((candidate, index, list) => list.findIndex(family => family.id === candidate.id) === index)
      setFamilies(available)
      let rememberedFamilyId = ''
      try {
        rememberedFamilyId = window.localStorage.getItem('kalasag_selected_family') ?? ''
      } catch {
        // Continue with the current or first family.
      }
      const selected = available.find(candidate => candidate.id === family?.id)
        ?? available.find(candidate => candidate.id === rememberedFamilyId)
        ?? available[0]
        ?? null
      setFamily(selected)
      setMessages([])
      if (selected && isOnline) await loadMessages(selected.id)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load family chat.')
    } finally {
      setLoading(false)
    }
  }, [family?.id, isOnline, loadMessages, user])

  useEffect(() => { void loadFamilies() }, [loadFamilies])

  useEffect(() => {
    if (!family || !isOnline) return
    void loadMessages(family.id).catch(loadError => setError(loadError.message))

    const channel = supabase.channel(`family-chat-${family.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'family_messages', filter: `family_id=eq.${family.id}` }, async payload => {
        const incoming = await hydrateMessage(payload.new as Message)
        setMessages(current => current.some(message => message.id === incoming.id) ? current : keepLatestMessages([...current, incoming]))
      })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [family, hydrateMessage, isOnline, loadMessages])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const sendMessage = useCallback(async (payload: OutboundMessage) => {
    const { data, error: insertError } = await supabase
      .rpc('send_family_message', {
        p_family_id: payload.family_id,
        p_content: payload.content,
        p_message_type: payload.message_type,
        p_lat: payload.latitude ?? null,
        p_lng: payload.longitude ?? null,
        p_media_path: payload.media_path ?? null,
      })
      .single()
    if (insertError) throw insertError
    const inserted = await hydrateMessage(data as Message)
    setMessages(current => current.some(message => message.id === inserted.id) ? current : keepLatestMessages([...current, inserted]))
  }, [hydrateMessage])

  const handleSend = async () => {
    if (!input.trim() || !family || !user) return
    if (!isOnline) { setError('Chat messages require a connection and are not stored on this device.'); return }
    const content = input.trim()
    if (content.length > MAX_MESSAGE_LENGTH) { setError(`Messages are limited to ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.`); return }
    setInput('')
    try {
      await sendMessage({ family_id: family.id, content, message_type: 'text' })
    } catch (sendError) {
      setInput(content)
      setError(sendError instanceof Error ? sendError.message : 'Message could not be sent.')
    }
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || !user || !family || !isOnline) return
    const safeExtension = ALLOWED_MEDIA_TYPES.get(file.type)
    if (!safeExtension) { setError('Only JPEG, PNG, WebP, GIF, MP4, and WebM files can be shared.'); return }
    if (file.type.startsWith('image/') && file.size > 5 * 1024 * 1024) { setError('Photos are limited to 5 MB.'); return }
    if (file.type.startsWith('video/') && file.size > 20 * 1024 * 1024) { setError('Videos are limited to 20 MB.'); return }

    setUploading(true)
    const mediaPath = `${family.id}/${user.id}/${crypto.randomUUID()}.${safeExtension}`
    try {
      const { error: uploadError } = await supabase.storage.from('chat_media').upload(mediaPath, file, { contentType: file.type, upsert: false })
      if (uploadError) throw uploadError
      await sendMessage({
        family_id: family.id,
        content: file.type.startsWith('video/') ? 'Sent a video' : 'Sent a photo',
        message_type: 'media',
        media_path: mediaPath,
      })
    } catch (uploadError) {
      await supabase.storage.from('chat_media').remove([mediaPath])
      setError(uploadError instanceof Error ? uploadError.message : 'Media could not be sent.')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleSendLocation = async () => {
    if (!family || !user || !isOnline) { setError('Location sharing requires a connection.'); return }
    try {
      const position = await getDevicePosition({
        enableHighAccuracy: true,
        maximumAge: 10_000,
        timeout: 20_000,
        enableLocationFallback: true,
      })
      if (!isValidCoordinate(position.coords.latitude, position.coords.longitude)) {
        setError('The device returned an invalid location. Please try again.')
        return
      }
      await sendMessage({
        family_id: family.id,
        content: 'Shared a location',
        message_type: 'location',
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      })
    } catch (locationError) {
      setError(locationError instanceof Error ? locationError.message : 'Location could not be sent.')
    }
  }

  if (loading) {
    return (
      <div role="status" aria-label="Loading family chat" className="flex h-full flex-col bg-[var(--surface)]">
        <div className="flex h-16 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4">
          <Skeleton variant="block" className="h-10 w-10" />
          <div className="flex-1 space-y-2"><Skeleton variant="line" className="w-36" /><Skeleton variant="line" className="h-2 w-24" /></div>
        </div>
        <div className="flex-1 space-y-5 p-4">
          <Skeleton variant="block" className="h-14 w-3/5" />
          <Skeleton variant="block" className="ml-auto h-16 w-2/3" />
          <Skeleton variant="block" className="h-20 w-4/5" />
        </div>
        <div className="flex gap-2 border-t border-[var(--border)] bg-[var(--panel)] p-3">
          <Skeleton variant="block" className="h-11 w-11" />
          <Skeleton variant="block" className="h-11 flex-1" />
          <Skeleton variant="block" className="h-11 w-11" />
        </div>
        <span className="sr-only">Loading family chat</span>
      </div>
    )
  }

  if (!family) {
    return (
      <div className="grid h-full place-items-center bg-[var(--surface)] p-4">
        <Panel className="max-w-sm p-6 text-center">
          <h1 className="text-base font-bold text-[var(--text)]">Family chat is not available yet</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--text-soft)]">Join a family or wait for membership approval before opening its chat.</p>
          <Button variant="secondary" onClick={onBack} className="mt-5">Back to Family Hub</Button>
        </Panel>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--surface)] animate-smooth-slide-up">
      <header className="z-10 flex h-16 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-3 sm:px-4">
        <IconButton onClick={onBack} aria-label="Back to family hub" title="Back to Family Hub"><ArrowLeft size={19} /></IconButton>
        <div className="min-w-0 flex-1">
          {families.length > 1 ? (
            <Select aria-label="Choose family chat" value={family.id} options={families.map(candidate => ({ value: candidate.id, label: candidate.name }))} onValueChange={value => {
              const selected = families.find(candidate => candidate.id === value) ?? null
              setFamily(selected)
              if (selected) {
                try { window.localStorage.setItem('kalasag_selected_family', selected.id) } catch { /* optional */ }
              }
            }} variant="minimal" className="max-w-full" contentClassName="min-w-52" />
          ) : <h1 className="truncate text-sm font-bold text-[var(--text)]">{family.name}</h1>}
          <p className="flex items-center gap-1 text-[10px] text-[var(--muted)]">{isOnline ? 'Live family chat' : <><WifiOff size={10} /> Offline — sending is paused</>}</p>
        </div>
      </header>

      {error && <div role="alert" aria-live="assertive" className="relative mx-3 mt-3 rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2.5 pr-10 text-xs text-[var(--danger)] sm:mx-4">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss chat error" className="ui-control absolute right-1 top-1 grid h-8 w-8 place-items-center rounded-md hover:bg-[var(--panel-elevated)]"><X size={15} /></button></div>}

      <main className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 sm:p-4" ref={scrollRef}>
        {messages.length === 0 ? <div className="mx-auto mt-10 max-w-xs text-center"><p className="text-sm font-semibold text-[var(--text)]">No messages yet</p><p className="mt-1 text-xs text-[var(--muted)]">Start the family conversation when you are ready.</p></div> : messages.map(message => {
          const isMine = message.user_id === user?.id
          const senderRole = message.user_id === family.host_id ? 'HOST' : 'MEMBER'
          if (message.message_type === 'status_update') return <div key={message.id} className="flex justify-center"><span className="rounded-full border border-[var(--border)] bg-[var(--panel-elevated)] px-3 py-1 text-[10px] text-[var(--muted)]"><strong>{message.first_name}</strong> <span className="font-bold text-[var(--action)]">{senderRole}</span> {message.content}</span></div>
          return <article key={message.id} className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}>
            {!isMine && <span className="mb-1 ml-1 text-[10px] text-[var(--muted)]">{message.first_name} · <strong className="text-[var(--action)]">{senderRole}</strong></span>}
            <div className={`max-w-[86%] break-words rounded-[var(--radius-lg)] px-3.5 py-2.5 text-sm [overflow-wrap:anywhere] sm:max-w-[78%] ${isMine ? 'rounded-br-sm bg-[var(--action)] text-white' : 'rounded-bl-sm border border-[var(--border)] bg-[var(--panel)] text-[var(--text)] shadow-[var(--shadow-sm)]'}`}>
              {message.message_type === 'media' ? message.media_url ? <div className="max-w-full">{isVideo(message.media_url) ? <video src={message.media_url} controls className="h-auto max-w-full rounded-lg sm:max-w-[250px]"><track kind="captions" src="data:text/vtt,WEBVTT%0A%0A" srcLang="en" label="Captions unavailable" /></video> : <img src={message.media_url} alt="Shared family media" className="h-auto max-w-full rounded-lg object-cover sm:max-w-[250px]" />}</div> : <span>Media is unavailable.</span>
                : message.message_type === 'location' && message.latitude != null && message.longitude != null && isValidCoordinate(message.latitude, message.longitude) ? <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${message.latitude},${message.longitude}`)}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 underline"><MapPin size={14} />View shared location</a>
                  : message.content}
            </div>
            <time className="mt-1 px-1 text-[9px] text-[var(--muted)]">{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          </article>
        })}
      </main>

      <footer className="shrink-0 border-t border-[var(--border)] bg-[var(--panel)] p-2.5 sm:p-3">
        <form onSubmit={event => { event.preventDefault(); void handleSend() }} className="mx-auto flex min-w-0 max-w-3xl items-center gap-1.5 sm:gap-2">
          <input type="file" accept="image/*,video/*" className="hidden" ref={fileInputRef} onChange={handleFileUpload} />
          <IconButton type="button" variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={!isOnline || uploading} aria-label="Send media" title="Send media">{uploading ? <Loader2 size={18} className="animate-spin" /> : <ImageIcon size={18} />}</IconButton>
          <IconButton type="button" variant="secondary" onClick={handleSendLocation} disabled={!isOnline} aria-label="Share location" title="Share location" className="hidden min-[370px]:inline-grid"><MapPin size={18} /></IconButton>
          <label htmlFor="family-chat-message" className="sr-only">Message</label>
          <Input id="family-chat-message" type="text" value={input} onChange={event => setInput(event.target.value)} maxLength={MAX_MESSAGE_LENGTH} placeholder={isOnline ? 'Message your family' : 'Reconnect to send'} aria-label="Message" disabled={!isOnline} className="h-11 min-w-0 flex-1" />
          <IconButton type="submit" variant="primary" disabled={!input.trim() || !isOnline} aria-label="Send message" title="Send message"><Send size={17} /></IconButton>
        </form>
      </footer>
    </div>
  )
}
