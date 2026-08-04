import { useState, useRef, useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import axios from 'axios';
import { api } from './lib/api';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { parse, format } from 'date-fns';
import './App.css';

/* Validation helpers for the consultant registration */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINKEDIN_RE = /^https?:\/\/([\w-]+\.)*linkedin\.com\/in\/.+/i;
const ARABIC_TEXT_RE = /^[؀-ۿ\s]+$/; // lettres arabes + espaces uniquement
const MAX_FILE_MB = 2;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

/* Normalise un mobile saoudien vers +9665XXXXXXXX (accepte 05…, 5…, 966…, +966…). */
const normalizeSaMobile = (input: string): string | null => {
  let d = (input || '').replace(/\D/g, '');
  if (d.startsWith('00966')) d = d.slice(5);
  else if (d.startsWith('966')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? '+966' + d : null;
};

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 900);
  useEffect(() => {
    const fn = () => setMobile(window.innerWidth < 900);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return mobile;
}

/* Literal Arabic strings (inlined from ar.json auth.register.*) — single-locale app. */
const CITY_OTHER = 'أخرى';
const PROP_OTHER = 'أخرى';
const REGION_OTHER = 'أخرى';

/* react-hook-form schema — Step 1 (personal info). Reprend les règles de validation existantes. */
const step1Schema = z
  .object({
    s1Name: z
      .string()
      .min(1, 'الاسم الكامل مطلوب')
      .refine(v => ARABIC_TEXT_RE.test(v.trim()), 'الاسم يجب أن يحتوي على حروف عربية ومسافات فقط')
      .refine(v => v.trim().split(/\s+/).length >= 3, 'يرجى إدخال الاسم الثلاثي (ثلاث كلمات على الأقل)'),
    s1Mobile: z
      .string()
      .min(1, 'رقم الجوال مطلوب')
      .refine(v => normalizeSaMobile(v) !== null, 'رقم الجوال غير صحيح. مثال: 05XXXXXXXX أو 5XXXXXXXX'),
    s1Email: z
      .string()
      .min(1, 'البريد الإلكتروني مطلوب')
      .refine(v => EMAIL_RE.test(v.trim()), 'صيغة البريد الإلكتروني غير صحيحة'),
    s1City: z.string().min(1, 'مدينة الإقامة مطلوبة'),
    s1CityOther: z.string().optional().default(''),
  })
  .superRefine((d, ctx) => {
    if (d.s1City === CITY_OTHER) {
      const v = (d.s1CityOther ?? '').trim();
      if (!v) ctx.addIssue({ path: ['s1CityOther'], code: 'custom', message: 'يرجى إدخال اسم المدينة' });
      else if (!ARABIC_TEXT_RE.test(v)) ctx.addIssue({ path: ['s1CityOther'], code: 'custom', message: 'اسم المدينة يجب أن يحتوي على حروف عربية فقط' });
      else if (v.length < 2) ctx.addIssue({ path: ['s1CityOther'], code: 'custom', message: 'اسم المدينة قصير جداً' });
    }
  });
type Step1Values = z.input<typeof step1Schema>;

/* react-hook-form schema — Step 2 (license info). */
const step2Schema = z.object({
  s2License: z
    .string()
    .min(1, 'رقم رخصة فال مطلوب')
    .refine(v => /^\d{10}$/.test(v.trim()), 'رقم الرخصة يجب أن يتكون من 10 أرقام'),
  s2Expiry: z.string().superRefine((val, ctx) => {
    const v = (val ?? '').trim();
    if (!v) { ctx.addIssue({ code: 'custom', message: 'تاريخ انتهاء الرخصة مطلوب' }); return; }
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
    if (!m) { ctx.addIssue({ code: 'custom', message: 'الصيغة غير صحيحة (يوم/شهر/سنة)' }); return; }
    const day = +m[1], month = +m[2], year = +m[3];
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
      ctx.addIssue({ code: 'custom', message: 'تاريخ غير صحيح' }); return;
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (d <= today) ctx.addIssue({ code: 'custom', message: 'يجب أن يكون تاريخ الانتهاء في المستقبل' });
  }),
  s2File: z.custom<File | null>().superRefine((f, ctx) => {
    if (!f) { ctx.addIssue({ code: 'custom', message: 'صورة الرخصة مطلوبة' }); return; }
    if (!/\.(jpg|jpeg|png|pdf)$/i.test(f.name)) ctx.addIssue({ code: 'custom', message: 'صيغة الملف غير مدعومة (JPG, PNG أو PDF فقط)' });
    if (f.size > MAX_FILE_BYTES) ctx.addIssue({ code: 'custom', message: `حجم الملف يجب ألا يتجاوز ${MAX_FILE_MB} ميجابايت` });
  }),
});
type Step2Values = z.infer<typeof step2Schema>;

/* react-hook-form schema — Step 3 (specialization & experience). */
const step3Schema = z
  .object({
    s3Props: z.array(z.string()).min(1, 'اختر نوع عقار واحد على الأقل'),
    s3PropOther: z.string().optional().default(''),
    s3Regions: z.array(z.string()).min(1, 'اختر منطقة تغطية واحدة على الأقل'),
    s3Years: z.string().min(1, 'سنوات الخبرة مطلوبة'),
    s3HasReports: z.boolean().nullable().refine(v => v !== null, 'هذا الحقل مطلوب'),
  })
  .superRefine((d, ctx) => {
    if (d.s3Props.includes(PROP_OTHER)) {
      const v = (d.s3PropOther ?? '').trim();
      if (!v) ctx.addIssue({ path: ['s3PropOther'], code: 'custom', message: 'يرجى تحديد نوع العقار الآخر' });
      else if (!ARABIC_TEXT_RE.test(v)) ctx.addIssue({ path: ['s3PropOther'], code: 'custom', message: 'يجب أن يحتوي على حروف عربية فقط' });
      else if (v.length < 2) ctx.addIssue({ path: ['s3PropOther'], code: 'custom', message: 'القيمة قصيرة جداً' });
    }
  });
type Step3Values = z.input<typeof step3Schema>;

/* react-hook-form schema — Step 4 (availability & professional profile). */
const step4Schema = z.object({
  s4Days: z.array(z.string()).min(1, 'اختر يوماً واحداً على الأقل'),
  s4Months: z.array(z.string()).min(1, 'اختر شهراً واحداً على الأقل'),
  s4Bio: z.string().max(500, 'النبذة يجب ألا تتجاوز 500 حرف').optional().default(''),
  s4Linkedin: z
    .string()
    .optional()
    .default('')
    .refine(v => !v || !v.trim() || LINKEDIN_RE.test(v.trim()), 'رابط LinkedIn غير صحيح (مثال: https://linkedin.com/in/username)'),
  s4Terms: z.boolean().refine(v => v === true, 'يجب الموافقة على الشروط والأحكام'),
});
type Step4Values = z.input<typeof step4Schema>;

/* ─────────────────────────────────────────────────────────────
   CONSULTANT MULTI-STEP REGISTRATION (standalone)
───────────────────────────────────────────────────────────── */
export default function App() {
  const isMobile = useIsMobile();
  const [step, setStep] = useState(1);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* Step 1 — react-hook-form */
  const step1Form = useForm<Step1Values>({
    resolver: zodResolver(step1Schema),
    mode: 'onTouched',
    defaultValues: { s1Name: '', s1Mobile: '', s1Email: '', s1City: '', s1CityOther: '' },
  });
  const s1City = step1Form.watch('s1City'); // pour l'affichage conditionnel « أخرى »

  /* Step 2 — react-hook-form */
  const step2Form = useForm<Step2Values>({
    resolver: zodResolver(step2Schema),
    mode: 'onTouched',
    defaultValues: { s2License: '', s2Expiry: '', s2File: null },
  });
  const s2File = step2Form.watch('s2File'); // pour l'aperçu du fichier choisi

  /* Step 3 */
  const PROP_TYPES = [
    'أراضي لوجستية أو صناعية',
    'أراضي زراعية',
    'أراضي تجارية',
    'أراضي سكنية',
    'وحدات لوجستية أو صناعية',
    'وحدات سكنية',
    'وحدات تجارية',
    'أخرى',
  ];
  const REGIONS = [
    'حائل',
    'منطقة الرياض',
    'مكة المكرمة',
    'المدينة المنورة',
    'الشرقية',
    'القصيم',
    'عسير',
    'تبوك',
    'الحدود الشمالية',
    'جازان',
    'نجران',
    'أخرى',
  ];
  const step3Form = useForm<Step3Values>({
    resolver: zodResolver(step3Schema),
    mode: 'onTouched',
    defaultValues: { s3Props: [], s3PropOther: '', s3Regions: [], s3Years: '', s3HasReports: null },
  });
  const s3Props = step3Form.watch('s3Props');
  const setS3Props = (v: string[]) => step3Form.setValue('s3Props', v, { shouldValidate: true, shouldTouch: true });
  const s3PropOther = step3Form.watch('s3PropOther');
  const setS3PropOther = (v: string) => step3Form.setValue('s3PropOther', v, { shouldValidate: true, shouldTouch: true });
  const s3Regions = step3Form.watch('s3Regions');
  const setS3Regions = (v: string[]) => step3Form.setValue('s3Regions', v, { shouldValidate: true, shouldTouch: true });
  const s3Years = step3Form.watch('s3Years');
  const setS3Years = (v: string) => step3Form.setValue('s3Years', v, { shouldValidate: true, shouldTouch: true });
  const s3HasReports = step3Form.watch('s3HasReports');
  const setS3HasReports = (v: boolean) => step3Form.setValue('s3HasReports', v, { shouldValidate: true, shouldTouch: true });

  /* Step 4 */
  const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const MONTHS = [
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
  ];
  const step4Form = useForm<Step4Values>({
    resolver: zodResolver(step4Schema),
    mode: 'onTouched',
    defaultValues: { s4Days: [], s4Months: [], s4Bio: '', s4Linkedin: '', s4Terms: false },
  });
  const s4Days = step4Form.watch('s4Days');
  const setS4Days = (v: string[]) => step4Form.setValue('s4Days', v, { shouldValidate: true, shouldTouch: true });
  const s4Months = step4Form.watch('s4Months');
  const setS4Months = (v: string[]) => step4Form.setValue('s4Months', v, { shouldValidate: true, shouldTouch: true });
  const s4Bio = step4Form.watch('s4Bio');
  const setS4Bio = (v: string) => step4Form.setValue('s4Bio', v, { shouldValidate: true, shouldTouch: true });
  const s4Linkedin = step4Form.watch('s4Linkedin');
  const setS4Linkedin = (v: string) => step4Form.setValue('s4Linkedin', v, { shouldValidate: true, shouldTouch: true });
  const s4Terms = step4Form.watch('s4Terms');
  const setS4Terms = (v: boolean) => step4Form.setValue('s4Terms', v, { shouldValidate: true, shouldTouch: true });

  /* Submit state */
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /* Which fields the user has interacted with — controls when errors show */
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const markTouched = (name: string) => setTouched(t => (t[name] ? t : { ...t, [name]: true }));

  const submitConsultant = async () => {
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const s1 = step1Form.getValues();
      const s2 = step2Form.getValues();
      const nameParts = s1.s1Name.trim().split(/\s+/);
      const firstName = nameParts[0] ?? s1.s1Name.trim();
      const lastName = nameParts.slice(1).join(' ') || firstName;

      const mobileNorm = normalizeSaMobile(s1.s1Mobile) ?? s1.s1Mobile;
      const cityFinal = s1.s1City === CITY_OTHER ? (s1.s1CityOther ?? '').trim() : s1.s1City;
      const propsFinal = s3Props.map(p => (p === PROP_OTHER ? (s3PropOther ?? '').trim() : p));

      const fd = new FormData();
      fd.append('FirstName', firstName);
      fd.append('LastName', lastName);
      fd.append('Mobile', mobileNorm);
      fd.append('Email', s1.s1Email);
      fd.append('City', cityFinal);
      fd.append('LicenseNumber', s2.s2License);
      fd.append('LicenseExpiry', s2.s2Expiry);
      fd.append('PropertyTypes', JSON.stringify(propsFinal));
      fd.append('Regions', JSON.stringify(s3Regions));
      fd.append('YearsExperience', s3Years);
      fd.append('HasWrittenReports', String(s3HasReports ?? false));
      fd.append('AvailableDays', JSON.stringify(s4Days));
      fd.append('AvailableMonths', JSON.stringify(s4Months));
      if (s4Bio) fd.append('Bio', s4Bio);
      if (s4Linkedin) fd.append('LinkedInUrl', s4Linkedin);
      fd.append('App', 'baseera');
      if (s2.s2File) fd.append('licenseFile', s2.s2File);

      await api.post('/auth/register/consultant', fd, {
        headers: { 'Content-Type': undefined },
      });
      setStep(5);
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        setSubmitError(err.response?.data?.message ?? 'حدث خطأ أثناء إرسال الطلب، حاول مرة أخرى');
      } else {
        setSubmitError('حدث خطأ أثناء إرسال الطلب، حاول مرة أخرى');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  /* Helpers */
  const toggle = (arr: string[], set: (v: string[]) => void, item: string) =>
    set(arr.includes(item) ? arr.filter(x => x !== item) : [...arr, item]);

  const selectAll = (all: string[], current: string[], set: (v: string[]) => void) =>
    set(current.length === all.length ? [] : [...all]);

  /* Circular progress */
  const r = 22;
  const circ = 2 * Math.PI * r;
  const progressDash = (circ * step) / 5;

  /* Common input style */
  const inp: React.CSSProperties = {
    width: '100%', height: '52px',
    border: '1.5px solid #D1D5DB', borderRadius: '13px',
    padding: '0 16px', fontSize: '14px', color: '#111',
    background: '#FFFFFF', outline: 'none',
    fontFamily: 'Alexandria, sans-serif',
    textAlign: 'right', boxSizing: 'border-box',
  };

  const lbl: React.CSSProperties = {
    display: 'block', fontSize: '13px', fontWeight: 500,
    color: '#374151', marginBottom: '8px', textAlign: 'right',
  };

  /* Pill button */
  const Pill = ({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) => (
    <button type="button" onClick={onClick} style={{
      padding: '7px 15px', borderRadius: '50px',
      border: selected ? '1.5px solid #1B4332' : '1.5px solid #D1D5DB',
      background: selected ? '#1B4332' : '#FFFFFF',
      color: selected ? '#FFFFFF' : '#374151',
      fontSize: '13px', fontWeight: 500, cursor: 'pointer',
      fontFamily: 'Alexandria, sans-serif', whiteSpace: 'nowrap',
      transition: 'all 0.15s',
    }}>
      {label}
    </button>
  );

  /* Section header with "تحديد الكل" */
  const SectionHead = ({
    title, items, selected, onToggleAll,
  }: { title: string; items: string[]; selected: string[]; onToggleAll: () => void }) => (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
      {/* Label — first in DOM = RIGHT in RTL */}
      <span style={{ fontSize: '13.5px', fontWeight: 600, color: '#111', textAlign: 'right' }}>
        {title} <span style={{ color: '#EF4444' }}>*</span>
      </span>
      {/* تحديد الكل — second = LEFT */}
      <label dir="ltr" style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px', color: '#374151', userSelect: 'none' }}>
        <input
          type="checkbox"
          checked={selected.length === items.length && items.length > 0}
          onChange={onToggleAll}
          style={{ width: '15px', height: '15px', cursor: 'pointer', accentColor: '#1B4332' }}
        />
        <span>تحديد الكل</span>
      </label>
    </div>
  );

  /* ── Erreurs & état "touché" combinés : react-hook-form (étapes 1-2) + système manuel (étapes 3-4) ── */
  const rhfForms = [step1Form, step2Form, step3Form, step4Form];
  const rhfError = (name: string): string | null => {
    for (const f of rhfForms) {
      const e = (f.formState.errors as Record<string, { message?: string }>)[name];
      if (e) return e.message ?? '';
    }
    return null;
  };
  const rhfTouched = (name: string): boolean =>
    rhfForms.some(
      f =>
        (f.formState.touchedFields as Record<string, boolean>)[name] ||
        (f.formState.errors as Record<string, unknown>)[name] != null,
    );
  const errors: Record<string, string | null> = {
    // Étape 1 : gérée par react-hook-form (zodResolver).
    s1Name: rhfError('s1Name'),
    s1Mobile: rhfError('s1Mobile'),
    s1Email: rhfError('s1Email'),
    s1City: rhfError('s1City'),
    s1CityOther: rhfError('s1CityOther'),
    s2License: rhfError('s2License'),
    s2Expiry: rhfError('s2Expiry'),
    s2File: rhfError('s2File'),
    s3Props: rhfError('s3Props'),
    s3PropOther: rhfError('s3PropOther'),
    s3Regions: rhfError('s3Regions'),
    s3Years: rhfError('s3Years'),
    s3HasReports: rhfError('s3HasReports'),
    s4Days: rhfError('s4Days'),
    s4Months: rhfError('s4Months'),
    s4Bio: rhfError('s4Bio'),
    s4Linkedin: rhfError('s4Linkedin'),
    s4Terms: rhfError('s4Terms'),
  };

  const stepFields: Record<number, string[]> = {
    1: ['s1Name', 's1Mobile', 's1Email', 's1City', 's1CityOther'],
    2: ['s2License', 's2Expiry', 's2File'],
    3: ['s3Props', 's3PropOther', 's3Regions', 's3Years', 's3HasReports'],
    4: ['s4Days', 's4Months', 's4Bio', 's4Linkedin', 's4Terms'],
  };

  /* Reveal every error on the current step (used when the user clicks Next/Submit) */
  // (kept for parity with the source; not directly invoked since NavRow uses form.trigger())
  void stepFields;

  /* "Touché" combiné : react-hook-form pour l'étape 1, système manuel pour le reste.
     On affiche aussi dès qu'une erreur RHF existe (trigger() remplit errors sans marquer touched). */
  const isTouched = (name: string) => rhfTouched(name) || touched[name];

  /* Red border applied to a field once it's touched and invalid */
  const errStyle = (name: string): React.CSSProperties =>
    isTouched(name) && errors[name] ? { borderColor: '#EF4444' } : {};

  /* Inline error message under a field */
  const ErrorMsg = ({ name }: { name: string }) =>
    isTouched(name) && errors[name] ? (
      <p style={{ fontSize: '12px', color: '#EF4444', textAlign: 'right', margin: '6px 2px 0' }}>
        {errors[name]}
      </p>
    ) : null;

  /* Navigation buttons */
  const NavRow = ({
    showBack = false,
    isLast = false,
  }: {
    showBack?: boolean;
    isLast?: boolean;
  }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '24px' }}>
      {submitError && isLast && (
        <p style={{ fontSize: '13px', color: '#EF4444', textAlign: 'right', margin: 0 }}>{submitError}</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: showBack ? 'space-between' : 'end' }}>
        {/* السابق — first in DOM = RIGHT in RTL — only if showBack */}
        {showBack && (
          <button type="button" onClick={() => setStep(s => s - 1)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: '6px',
            fontSize: '14px', fontWeight: 600, color: '#374151',
            fontFamily: 'Alexandria, sans-serif',
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} style={{ transform: 'scaleX(-1)' }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
            السابق
          </button>
        )}
        {/* Spacer when no back */}
        {!showBack && <span />}
        {/* التالي / إرسال الطلب — second = LEFT in RTL */}
        <button
          type="button"
          onClick={async () => {
            if (isSubmitting) return;
            if (step === 1) { if (await step1Form.trigger()) setStep(2); return; }
            if (step === 2) { if (await step2Form.trigger()) setStep(3); return; }
            if (step === 3) { if (await step3Form.trigger()) setStep(4); return; }
            if (step === 4) { if (await step4Form.trigger()) submitConsultant(); return; }
          }}
          disabled={isSubmitting}
          style={{
            height: '48px', padding: '0 28px',
            background: isSubmitting ? '#E8C98A' : '#D4A853',
            border: 'none', borderRadius: '28px',
            fontSize: '15px', fontWeight: 700, color: '#1a1a1a',
            cursor: isSubmitting ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', gap: '8px',
            fontFamily: 'Alexandria, sans-serif', whiteSpace: 'nowrap',
            opacity: isSubmitting ? 0.65 : 1,
            transition: 'background 0.15s, opacity 0.15s',
          }}
        >
          {isSubmitting ? 'جارٍ الإرسال...' : isLast ? 'إرسال الطلب' : 'التالي'}
          {!isSubmitting && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );

  const [isExpiryCalendarOpen, setIsExpiryCalendarOpen] = useState(false);

  const openExpiryCalendar = () => {
    setIsExpiryCalendarOpen(true);
  };

  const closeExpiryCalendar = () => {
    setIsExpiryCalendarOpen(false);
  };

  /* ── Step 5: Success ── */
  if (step === 5) {
    return (
      <div dir="rtl" style={{
        minHeight: '100vh', background: '#F5F5F5',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '32px 20px', fontFamily: 'Alexandria, sans-serif',
      }}>
        <div style={{
          width: '100%', maxWidth: '560px', margin: 'auto',
          background: '#FFFFFF', borderRadius: '24px',
          boxShadow: '0 4px 32px rgba(0,0,0,0.10)',
          padding: isMobile ? '40px 28px' : '52px 52px',
          textAlign: 'center',
        }}>
          {/* Clipboard icon */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '24px', position: 'relative' }}>
            {/* Sparkle dots */}
            <div style={{ position: 'absolute', top: '-8px', left: '50%', transform: 'translateX(-50%)', width: '140px', height: '140px' }}>
              {[[-38, 18], [38, 18], [-28, 72], [28, 72], [0, -8]].map(([x, y], i) => (
                <div key={i} style={{
                  position: 'absolute', left: `calc(50% + ${x}px)`, top: `${y}px`,
                  width: '5px', height: '5px', borderRadius: '50%',
                  background: i % 2 === 0 ? '#D4A853' : '#1B7A5C', opacity: 0.6,
                }} />
              ))}
            </div>
            <svg width="88" height="88" viewBox="0 0 88 88" fill="none">
              {/* Board */}
              <rect x="14" y="24" width="60" height="58" rx="7" fill="#EAF4F0" stroke="#1B7A5C" strokeWidth="2.5" />
              {/* Clip top */}
              <rect x="30" y="16" width="28" height="16" rx="5" fill="#EAF4F0" stroke="#1B7A5C" strokeWidth="2.5" />
              {/* Inner circle */}
              <circle cx="44" cy="54" r="17" fill="#D4A853" />
              {/* Checkmark */}
              <path d="M37 54L42 59L51 48" stroke="white" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <h1 style={{ fontSize: '26px', fontWeight: 800, color: '#111', marginBottom: '8px' }}>تهانينا!</h1>
          <p style={{ fontSize: '15px', fontWeight: 700, color: '#1B7A5C', marginBottom: '6px' }}>
            تم استلام طلب تسجيلك بنجاح
          </p>
          <p style={{ fontSize: '13px', color: '#9CA3AF', marginBottom: '24px' }}>
            جار حالياً مراجعة بياناتك من قبل فريقنا المختص
          </p>

          {/* Status box */}
          <div style={{
            border: '1.5px solid #D4A853', background: '#FFFDF5',
            borderRadius: '14px', padding: '18px 20px',
            marginBottom: '28px', textAlign: 'right',
          }}>
            <p style={{ fontSize: '14px', fontWeight: 700, color: '#D4A853', marginBottom: '8px' }}>
              حالة الطلب : قيد الانتظار
            </p>
            <p style={{ fontSize: '13px', color: '#374151', lineHeight: 1.7, margin: 0 }}>
              سيتم إشعارك عبر البريد الإلكتروني أو الرسائل النصية بمجرد الانتهاء من المراجعة.
            </p>
          </div>

          {/* 3 info items */}
          <div style={{
            display: 'flex', flexDirection: 'row',
            borderTop: '1px solid #E5E7EB', borderBottom: '1px solid #E5E7EB',
            padding: '20px 0', marginBottom: '32px',
          }}>
            {/* Right: clock */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '0 8px', borderLeft: '1px solid #E5E7EB' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth={1.5}>
                <circle cx="12" cy="12" r="10" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2" />
              </svg>
              <p style={{ fontSize: '12px', color: '#374151', textAlign: 'center', lineHeight: 1.5, margin: 0 }}>
                سنراجع بياناتك خلال<br />1-3 أيام عمل
              </p>
            </div>
            {/* Middle: bell */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '0 8px', borderLeft: '1px solid #E5E7EB' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 17H5a1 1 0 01-.894-1.447l1.447-2.894A2 2 0 006 11V8a6 6 0 1112 0v3a2 2 0 00.447 1.659l1.447 2.894A1 1 0 0119 17h-4z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.73 21a2 2 0 01-3.46 0" />
              </svg>
              <p style={{ fontSize: '12px', color: '#374151', textAlign: 'center', lineHeight: 1.5, margin: 0 }}>
                سنتواصل معك<br />لإعلامك بنتيجة الطلب
              </p>
            </div>
            {/* Left: badge */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '0 8px' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
              </svg>
              <p style={{ fontSize: '12px', color: '#374151', textAlign: 'center', lineHeight: 1.5, margin: 0 }}>
                بعد الموافقة ستمكن<br />من استخدام المنصة
              </p>
            </div>
          </div>

          {/* CTA button */}
          {/* <button
            type="button"
            onClick={() => navigate('/login')}
            style={{
              height: '52px', padding: '0 40px',
              background: '#D4A853', border: 'none', borderRadius: '28px',
              fontSize: '15px', fontWeight: 700, color: '#1a1a1a',
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '10px',
              fontFamily: 'Alexandria, sans-serif',
            }}
          >
            العودة إلى الصفحة الرئيسية
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
          </button> */}
        </div>
      </div>
    );
  }

  /* ── Steps 1-4: Two-column layout ── */
  const stepSubtitles: Record<number, string> = {
    1: 'المعلومات الشخصية',
    2: 'معلومات الرخصة',
    3: 'التخصص والخبرة',
    4: 'التوفر والملف المهني',
  };

  return (
    <div
      dir="rtl"
      style={{
        minHeight: '100vh', background: '#ECECEC',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '32px 20px', fontFamily: 'Alexandria, sans-serif',
        boxSizing: 'border-box',
      }}
    >
      <div style={{
        width: '100%', maxWidth: '620px',
        background: '#FFFFFF', borderRadius: '28px',
        boxShadow: '0 4px 32px rgba(0,0,0,0.10)',
        display: 'flex', flexDirection: 'row', overflow: 'hidden',
        minHeight: isMobile ? 'auto' : '620px', margin: 'auto',
      }}>

        {/* ── RIGHT: Form panel (first in DOM = right in RTL) ── */}
        <div style={{
          flex: 1, minWidth: 0, padding: isMobile ? '36px 22px' : '44px 52px',
          display: 'flex', flexDirection: 'column',
          overflowY: 'auto',
        }}>

          {/* Header: title (right) + progress circle (left) */}
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '28px' }}>
            {/* Title + subtitle — first = RIGHT */}
            <div>
              <h1 style={{ fontSize: isMobile ? '22px' : '28px', fontWeight: 800, color: '#111', textAlign: 'right', margin: '0 0 5px' }}>
                طلب تسجيل مستشار مرخص
              </h1>
              <p style={{ fontSize: '14px', fontWeight: 600, color: '#1B7A5C', margin: 0 }}>
                {stepSubtitles[step]}
              </p>
            </div>

            {/* Circular progress — second = LEFT */}
            <div style={{ position: 'relative', width: '56px', height: '56px', flexShrink: 0 }}>
              <svg width="56" height="56" viewBox="0 0 56 56">
                <circle cx="28" cy="28" r={r} fill="none" stroke="#E5E7EB" strokeWidth="4" />
                <circle
                  cx="28" cy="28" r={r} fill="none"
                  stroke="#D4A853" strokeWidth="4"
                  strokeDasharray={`${progressDash} ${circ - progressDash}`}
                  strokeLinecap="round"
                  transform="rotate(-90 28 28)"
                />
              </svg>
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1px' }}>
                <span style={{ fontSize: '15px', fontWeight: 800, color: '#111', lineHeight: 1 }}>{step}</span>
                <span style={{ fontSize: '9px', color: '#6B7280', lineHeight: 1.2 }}>من 5</span>
              </div>
            </div>
          </div>

          {/* ─── STEP 1: المعلومات الشخصية ─── */}
          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* 2-column: الاسم الكامل + رقم جوالك */}
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '14px', direction: 'rtl' }}>
                {/* الاسم الكامل — first = RIGHT */}
                <div>
                  <label style={lbl}>
                    الاسم الكامل <span style={{ color: '#EF4444' }}>*</span>
                  </label>
                  <input
                    type="text"
                    {...step1Form.register('s1Name')}
                    placeholder="أدخل اسمك الكامل باللغة العربية"
                    style={{ ...inp, ...errStyle('s1Name') }}
                  />
                  <ErrorMsg name="s1Name" />
                </div>
                {/* رقم جوالك — second = LEFT */}
                <div>
                  <label style={lbl}>
                    رقم جوالك <span style={{ color: '#EF4444' }}>*</span>
                  </label>
                  <div style={{
                    display: 'flex', flexDirection: 'row', alignItems: 'stretch',
                    border: '1.5px solid #D1D5DB', borderRadius: '13px',
                    overflow: 'hidden', height: '52px',
                    ...errStyle('s1Mobile'),
                  }}>
                    {/* Input — first = RIGHT */}
                    <input
                      type="tel"
                      {...step1Form.register('s1Mobile')}
                      placeholder="أدخل رقم جوالك"
                      dir="rtl"
                      style={{ flex: 1, border: 'none', outline: 'none', padding: '0 12px', fontSize: '14px', color: '#111', background: 'transparent', fontFamily: 'Alexandria, sans-serif', textAlign: 'right', minWidth: 0 }}
                    />
                    {/* +966 — second = LEFT */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '5px',
                      padding: '0 11px',
                      borderRadius: '0 12px 12px 0', flexShrink: 0,
                    }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: 'black', fontFamily: 'monospace' }}>966+</span>
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M2 3.5L5 6.5L8 3.5" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <svg width="46" height="34" viewBox="0 0 46 34" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block', borderRadius: '4px', flexShrink: 0, width: '46px', height: '34px' }}>
                        <g clipPath="url(#clip0_flag_reg1)">
                          <path d="M0 34H46V0H0V34Z" fill="#005430" />
                          <path d="M34.5 13.5052C34.4968 12.9079 34.2878 11.2991 34.2347 10.7594C34.1818 10.2196 34.1284 9.73003 34.1413 9.61533C34.1539 9.50472 34.3075 9.76918 34.3887 9.79055C34.4307 9.78125 34.4119 9.6142 34.3356 9.47151C34.284 9.37467 34.1079 9.01251 34.0011 8.80024C33.9508 8.69977 33.9396 8.64157 33.9154 8.62916C33.8913 8.61687 33.6969 9.05178 33.7181 9.10006C33.7712 9.18846 33.8076 9.23062 33.8158 9.38674C33.8242 9.54286 33.8971 10.6576 33.9899 11.5026C34.0597 12.14 34.213 13.5133 34.2185 14.3672C34.22 14.6457 34.1922 14.9112 34.1587 15.0221C34.0729 15.1963 33.9388 15.3535 33.4393 15.6775C32.8777 16.0418 32.1286 16.3451 31.8066 16.548C31.6064 16.6746 31.6727 16.6915 31.8471 16.6361C32.0209 16.5807 32.92 16.4032 33.3568 16.1986C33.7668 16.006 34.033 15.6838 34.235 15.2138C34.4845 14.6328 34.5035 14.1397 34.5 13.5052ZM32.7616 8.96826C32.805 8.94961 33.1643 8.9291 33.2611 8.9512C33.1975 9.05195 32.7666 9.27494 32.7648 9.31585C32.7766 9.34339 33.0625 9.26485 33.1526 9.22122C33.2116 9.18195 33.2509 9.12109 33.2946 9.0706C33.3976 8.93913 33.5198 8.69535 33.489 8.66475C33.439 8.61539 32.9492 8.64611 32.8846 8.65625C32.8414 8.66316 32.7316 8.88133 32.7115 8.93732C32.6918 8.99325 32.7182 8.9869 32.7616 8.96826Z" fill="white" />
                          <path d="M33.4955 12.5082C33.5811 12.1873 33.5781 11.8454 33.4869 11.5265C33.3822 11.1566 33.1221 10.9312 32.9345 10.8157L32.901 11.1717C32.901 11.1717 33.1641 11.3167 33.344 11.6816C33.4579 11.9131 33.5054 12.2404 33.4154 12.6053C33.4004 12.6959 33.4588 12.646 33.4955 12.5081M30.7125 14.2936C30.7895 14.0047 30.7869 13.6968 30.7049 13.4096C30.6105 13.0766 30.3763 12.8735 30.2073 12.7698L30.1771 13.0903C30.1771 13.0903 30.414 13.2209 30.5759 13.5492C30.6787 13.7575 30.7213 14.0527 30.6405 14.3811C30.627 14.4624 30.6795 14.4176 30.7125 14.2936ZM21.0505 9.44583C21.1589 9.66552 21.2038 9.97668 21.1186 10.3232C21.1043 10.4092 21.1595 10.362 21.1946 10.2311C21.2757 9.92624 21.2728 9.60145 21.1862 9.29844C21.0866 8.94705 20.8396 8.73307 20.6613 8.62354L20.6299 8.96167C20.6299 8.96167 20.8797 9.09925 21.0505 9.44583ZM14.5281 9.5595C14.6191 9.79603 14.6252 10.1153 14.4783 10.4517C14.4497 10.5362 14.5193 10.4962 14.5777 10.3698C14.6969 10.1113 14.7639 9.78781 14.7034 9.43053C14.6414 9.06316 14.3925 8.81275 14.2061 8.67714L14.1216 9.01278C14.1216 9.01278 14.3846 9.18675 14.5281 9.5595Z" fill="white" />
                          <path d="M16.3314 14.8455C16.447 14.6075 16.4952 14.4474 16.5466 14.1655C16.5915 13.9176 16.5944 13.6312 16.5782 13.3395C16.9243 13.1831 17.3367 12.9236 17.4753 12.9045C17.3805 13.2653 17.6068 13.6546 18.0637 13.6037C18.0987 14.0117 18.1286 14.3701 18.1469 14.5826C18.1841 15.0183 18.1785 15.5673 18.1774 15.6628C18.1759 15.7586 18.2384 15.7405 18.3027 15.527C18.3883 15.2411 18.4148 14.4946 18.3837 14.001C18.3763 13.8775 18.3637 13.7109 18.3485 13.5211C18.6447 13.3691 18.694 13.0758 18.8047 12.9508C18.9047 13.339 19.4548 13.3917 19.6247 13.3085C19.8352 13.2054 19.9042 13.0198 19.9584 12.5892C20.0128 12.1587 19.8546 11.9853 19.798 11.9384C19.7924 11.9905 19.6546 12.4965 19.6546 12.4965C19.6546 12.4965 19.7853 12.6495 19.7919 12.7247C19.6854 12.8314 19.461 12.838 19.2726 12.77C19.084 12.702 19.0262 12.5769 19.0374 12.4929C19.0483 12.4087 19.1193 12.332 19.1217 12.2294C19.1237 12.1268 19.0794 12.1565 19.0039 12.2474C18.9285 12.3384 18.8797 12.4202 18.7753 12.6155C18.69 12.7751 18.5513 12.97 18.3069 13.0257C18.2665 12.5568 18.2205 12.0578 18.1897 11.7444C18.1736 11.5789 18.0128 10.149 18.0013 9.98907C17.9913 9.84967 17.9727 9.6854 17.9758 9.60822C17.9788 9.54679 18.0136 9.57116 18.0674 9.63542C18.1212 9.69962 18.2155 9.81154 18.2317 9.80281C18.2866 9.77295 18.2305 9.58708 18.1586 9.42065C18.0869 9.25377 17.8422 8.59536 17.7909 8.56821C17.7644 8.55444 17.5992 8.95972 17.5894 9.03951C17.615 9.08938 17.6819 9.16792 17.6843 9.39124C17.6852 9.45352 17.7213 10.0407 17.7714 10.596C17.8152 11.0863 17.8733 11.5515 17.8789 11.6056C17.9188 11.9799 17.9672 12.5074 18.0133 13.026C17.748 12.97 17.6774 12.7761 17.6833 12.6654C17.6901 12.5405 17.7409 12.3996 17.7165 12.3678C17.6654 12.3338 17.3613 12.5222 16.9373 12.7247C16.8069 12.7871 16.675 12.8457 16.5418 12.9003C16.5048 12.5468 16.4561 12.2107 16.4365 11.9538L16.4342 11.9252C16.713 11.9053 16.9413 11.7491 17.0452 11.6005C17.175 11.4146 17.2657 11.0321 17.2745 10.7392C17.2834 10.4458 17.0699 9.90957 17.0191 9.73906C16.9678 9.56849 16.9414 9.45017 16.9369 9.39124C16.9323 9.33225 17.0522 9.45952 17.1277 9.48451C17.1788 9.49585 17.1612 9.37311 17.0987 9.2889C17.0367 9.20492 16.7013 8.64058 16.6778 8.68013C16.6633 8.70336 16.5289 9.11856 16.5201 9.18214C16.573 9.2209 16.6349 9.32766 16.6392 9.42994C16.6437 9.53228 16.7176 9.98216 16.7996 10.2322C16.8817 10.4821 17.0567 10.9617 17.0678 11.0936C16.9428 11.1913 16.6581 11.3568 16.3766 11.3469C16.3285 10.9095 16.2674 10.4015 16.2348 10.0417C16.2222 9.90266 16.2213 9.7543 16.2233 9.67678C16.2249 9.61536 16.2647 9.62386 16.3196 9.68698C16.3748 9.75011 16.4594 9.84197 16.4767 9.83534C16.5145 9.82145 16.4817 9.68211 16.4069 9.51664C16.332 9.35118 16.0343 8.65134 15.9821 8.62522C15.9557 8.61185 15.8224 9.00489 15.814 9.08513C15.8406 9.13477 15.9087 9.21155 15.9154 9.43482C15.9208 9.61264 15.9989 10.484 16.0658 11.2514C15.7872 11.0918 15.6922 10.8634 15.6577 10.4801C15.6337 10.2129 15.6313 9.7207 15.5453 9.30896C15.4969 9.07623 15.3948 8.83976 15.2739 8.71419C15.245 8.79154 15.1162 9.26635 15.1162 9.26635C15.1582 9.40269 15.2888 9.86174 15.2844 10.2595C15.28 10.6573 15.2518 11.0462 14.8497 11.3141C14.4479 11.5822 13.8452 11.4756 13.6963 11.0574C13.5476 10.639 13.8784 9.5898 13.874 9.34211C13.8696 9.09448 13.8296 9.06031 13.7363 9.10122C13.643 9.14208 13.4522 9.38087 13.2879 9.76932C13.1235 10.1581 13.0504 10.6395 12.957 10.9669C12.8639 11.2942 12.7149 11.6259 12.4841 11.6075C12.2534 11.5894 12.1292 11.3553 12.0582 11.0168C11.9871 10.678 12.0306 10.2318 12.05 10.1175C12.0982 9.83103 11.9866 9.88974 11.9182 10.3395C11.876 10.6169 11.834 11.0598 11.9828 11.5236C12.1313 11.9872 12.3846 12.1601 12.6065 12.1009C12.8285 12.0419 13.0237 11.4645 13.0926 11.2053C13.1613 10.9463 13.4688 9.79652 13.643 9.73991C13.6674 9.86951 13.5076 10.2873 13.4565 10.7759C13.4056 11.2645 13.5245 11.9209 14.0839 12.0345C14.6433 12.1481 15.0228 11.7458 15.1605 11.4665C15.2982 11.1869 15.3625 10.8936 15.378 10.746C15.3959 11.1209 15.6267 11.7062 16.0748 11.8731L16.121 11.8879C16.1486 12.1947 16.1935 12.5952 16.2348 13.0158C16.1479 13.0456 16.0603 13.0723 15.9719 13.0959C15.9607 13.0556 15.9484 13.0161 15.9334 12.9798C15.7966 12.6536 15.5702 12.353 15.2565 12.3738C14.936 12.3949 14.5866 12.869 14.6019 13.2153C14.6119 13.4482 14.7276 13.6394 15.1482 13.6883C15.3402 13.7108 15.5442 13.6871 15.7548 13.6361C15.7845 13.7325 15.8033 13.8282 15.8054 13.9155C15.6721 14.0882 14.5694 15.0104 13.7437 15.099C12.918 15.1876 12.6661 14.7077 12.6579 14.226C12.6517 13.8595 12.8505 13.4937 12.9902 13.2406C13.1901 13.0784 13.3542 12.8756 13.4578 12.7192C13.4859 12.7385 13.5127 12.7562 13.5382 12.7727C13.6369 12.8363 13.6762 12.9313 13.6762 12.9313C13.6944 12.9003 13.7792 12.7309 13.7461 12.6482C13.7308 12.6278 13.6562 12.5769 13.5665 12.5164C13.6607 12.2561 13.6594 11.9962 13.5373 11.9384C13.4009 11.874 13.2226 12.053 13.1458 12.1622C13.1104 12.2124 13.091 12.274 13.0903 12.3376C13.0898 12.4072 13.1193 12.4701 13.1924 12.526C13.2652 12.5812 13.3328 12.6311 13.3963 12.6761C13.2159 12.8862 12.7895 13.1941 12.5285 13.3748C12.5188 13.3483 12.4806 13.3763 12.4292 13.4434L12.3586 13.4918C12.1504 13.633 11.6512 13.9432 11.5531 14.019C11.4547 14.0951 11.5164 14.0814 11.5531 14.0644C11.6223 14.0229 11.7133 13.9727 11.8155 13.9173C11.9603 13.8388 12.1287 13.75 12.2933 13.6608C12.2392 13.7624 12.1912 13.8678 12.1495 13.9763C11.9531 14.4904 11.6356 15.5561 12.3224 16.1973C12.9796 16.8111 14.1091 16.5775 15.0458 15.9397C15.9826 15.3017 16.1849 15.0774 16.3314 14.8455M13.2772 12.3106C13.2447 12.2841 13.2402 12.2487 13.2667 12.2239C13.3004 12.1921 13.3436 12.162 13.3926 12.1518C13.4964 12.1304 13.5379 12.2627 13.4962 12.4688C13.4172 12.4153 13.336 12.359 13.2772 12.3106ZM15.4259 13.1799C14.9489 13.1823 14.9269 13.0863 14.9359 13.0249C14.9447 12.9637 15.0933 12.7959 15.2817 12.9066C15.3613 12.9535 15.4511 13.0517 15.5341 13.175C15.4974 13.178 15.4613 13.1795 15.4259 13.1799ZM13.965 15.9608C13.0638 16.2335 12.1848 15.811 12.1316 14.9745C12.0909 14.3357 12.301 13.8545 12.4365 13.5832C12.5658 13.5124 12.6878 13.4435 12.7888 13.3818C12.5529 13.803 12.4148 14.367 12.5071 14.8449C12.6115 15.3862 13.0363 15.7144 13.7554 15.6085C14.4675 15.5039 15.4302 14.7531 15.7032 14.4699C15.7864 14.3678 15.8412 14.2756 15.916 14.0879C15.9468 14.0109 15.9901 13.9092 16.0062 13.7942C16.0167 13.7193 16.0223 13.6392 16.0235 13.5577C16.1083 13.5294 16.1923 13.4987 16.2757 13.4657C16.3044 13.8084 16.3255 14.1463 16.3268 14.4384C15.8831 15.0152 14.8662 15.688 13.965 15.9608ZM29.7275 13.7673C29.697 13.2076 29.6234 12.1946 29.5822 11.6807C29.5458 11.2234 29.4743 10.5965 29.422 10.0448C29.4113 9.92874 29.4069 9.8121 29.4088 9.69548C29.4103 9.6344 29.4655 9.65791 29.5207 9.72076C29.5758 9.7836 29.662 9.86254 29.6783 9.8529C29.7321 9.82191 29.6676 9.66868 29.5919 9.50378C29.5162 9.3386 29.2159 8.65537 29.1636 8.62941C29.1371 8.61621 28.9963 9.02551 28.9882 9.1057C29.0151 9.15505 29.0838 9.23155 29.0913 9.45482C29.0988 9.67826 29.2006 10.7055 29.2741 11.5362C29.325 12.1137 29.3909 13.0559 29.4387 13.7664C29.4364 13.7675 29.484 14.4419 29.4891 14.5176C29.5186 14.9539 29.5033 15.5028 29.5004 15.5981C29.4971 15.6938 29.5603 15.6772 29.628 15.4648C29.697 15.2479 29.7364 14.7638 29.7417 14.3266L29.7275 13.7673Z" fill="white" />
                          <path d="M17.2406 14.0585C17.3418 13.8154 17.3785 13.5721 17.304 13.7016C17.1373 13.9916 16.8233 14.5532 16.7161 14.951C16.6087 15.3489 16.6882 15.6284 16.8359 15.7431C17.0201 15.8855 17.1908 15.7311 17.3276 15.4855C17.4585 15.25 17.4845 14.9551 17.409 15.0141C17.3439 15.0772 17.2876 15.3146 17.2162 15.3271C17.0695 15.3526 16.8747 15.1543 16.9427 14.8135C17.0043 14.506 17.1676 14.2344 17.2406 14.0585ZM31.414 16.4687C31.4915 16.3983 32.166 15.9954 32.2902 15.9136C32.2902 15.9136 32.4172 15.684 32.3792 15.6596C32.3409 15.6352 32.0946 15.8834 31.9415 15.8903C31.7882 15.8973 31.5784 15.7724 31.5716 15.6701C31.5915 15.5929 31.7759 15.4769 31.8425 15.4722C31.9091 15.4679 31.8984 15.6361 31.9206 15.6566C31.9429 15.6768 32.0316 15.5405 32.0427 15.4837C32.0536 15.427 32.0445 15.1896 31.9226 15.2236C31.7295 15.2778 31.4384 15.6747 31.4051 15.7995C31.3717 15.9247 31.5516 16.0335 31.6829 16.0929C31.6717 16.0974 31.5737 16.1497 31.5117 16.2177C31.5117 16.2177 31.4451 16.3005 31.414 16.4687ZM29.114 16.9676C29.1915 16.8972 29.866 16.4946 29.9902 16.4126C29.9902 16.4126 30.1175 16.183 30.0792 16.1586C30.0409 16.1342 29.7946 16.3824 29.6415 16.3893C29.4882 16.3962 29.2784 16.2714 29.2716 16.169C29.2915 16.0919 29.4759 15.9759 29.5425 15.9714C29.6091 15.9668 29.5984 16.1349 29.6206 16.1553C29.6429 16.1758 29.7316 16.0394 29.7427 15.9827C29.7536 15.926 29.7442 15.6886 29.6226 15.7226C29.4295 15.777 29.1384 16.1736 29.1051 16.2987C29.0717 16.4236 29.2516 16.5326 29.3827 16.5918C29.3717 16.5964 29.2737 16.6485 29.2117 16.7167C29.2117 16.7167 29.1451 16.7995 29.114 16.9676ZM23.9333 9.74774C23.9937 9.82566 24.3899 10.3838 24.7003 10.7346C25.0105 11.0858 25.5423 11.6541 25.9331 12.0435C26.013 12.1234 26.0922 12.2042 26.1705 12.2859C26.2691 13.1248 26.3831 14.1923 26.4309 14.6338C26.4781 15.0684 26.4851 15.6173 26.4861 15.7129C26.4869 15.8086 26.5491 15.7891 26.6082 15.5743C26.6874 15.2859 26.6965 14.5395 26.6545 14.0464C26.6285 13.7419 26.567 13.1714 26.5075 12.6455C26.7382 12.8982 26.9562 13.1489 27.1031 13.3366C27.3731 13.6811 27.6003 13.9411 27.7388 14.3114C27.8368 14.5735 27.8269 14.782 27.867 14.8231C27.9018 14.8587 27.9401 14.5452 27.8972 14.2411C27.8278 13.7473 27.7327 13.5379 27.1609 12.833C26.9427 12.5634 26.686 12.2817 26.435 12.0184C26.4253 11.9372 26.4165 11.862 26.4085 11.7952C26.3886 11.6303 26.1949 10.2048 26.1796 10.0451C26.1666 9.90601 26.1438 9.7423 26.1456 9.66495C26.147 9.60335 26.1823 9.62732 26.2377 9.69022C26.2929 9.7529 26.3895 9.86266 26.4059 9.85308C26.4599 9.82209 26.3997 9.63798 26.324 9.47279C26.2485 9.30789 25.9885 8.65555 25.9363 8.62971C25.9098 8.6165 25.754 9.02564 25.7461 9.10571C25.7731 9.15506 25.8416 9.23202 25.8491 9.455C25.8512 9.51728 25.901 10.1036 25.9636 10.6572C26.0191 11.1464 26.0876 11.6104 26.0948 11.6641L26.0951 11.6682C25.8362 11.4065 25.6082 11.1842 25.4699 11.0446C25.1464 10.7187 24.4322 9.94534 24.4035 9.82951C24.397 9.79296 24.4525 9.81546 24.5544 9.83353C24.6567 9.85178 24.7477 9.89037 24.7314 9.83467C24.7239 9.80843 24.6847 9.7436 24.5872 9.67668C24.4895 9.6097 24.2391 9.43607 24.0529 9.31322C23.8664 9.19054 23.7739 9.08763 23.7354 9.11704C23.7164 9.13155 23.7334 9.55184 23.7445 9.60426C23.7911 9.60868 23.8731 9.66954 23.9332 9.74774" fill="white" />
                          <path d="M24.4433 8.99212C24.5199 8.97348 24.8827 8.98362 25.0145 9.01439C24.9593 9.05689 24.5881 9.2648 24.5147 9.31433C24.4417 9.36397 24.4233 9.39264 24.46 9.38777C24.5663 9.35507 24.8062 9.31433 24.9211 9.24786C25.0295 9.19159 25.2141 8.91721 25.2859 8.81493C25.3573 8.71259 25.3573 8.66153 25.3391 8.6341C25.2658 8.5899 24.7929 8.54553 24.5648 8.60826C24.5017 8.65575 24.3782 8.90877 24.36 8.96141C24.3418 9.01439 24.3667 9.01077 24.4433 8.99212M26.4615 8.9592C26.5234 8.94413 26.8159 8.95229 26.9219 8.97699C26.8775 9.01128 26.5784 9.1789 26.5194 9.21907C26.4602 9.25885 26.4454 9.28209 26.475 9.27806C26.5608 9.252 26.7542 9.21913 26.8467 9.1653C26.9339 9.11996 27.0827 8.89879 27.1406 8.81657C27.1981 8.73389 27.1981 8.69287 27.1834 8.67094C27.1246 8.6349 26.7433 8.59931 26.5595 8.64997C26.5086 8.68811 26.4093 8.89205 26.3946 8.93449C26.3797 8.97699 26.4 8.97427 26.4615 8.9592ZM28.1022 8.93585C28.1638 8.92078 28.4563 8.92894 28.5622 8.95365C28.5182 8.98793 28.219 9.15555 28.1598 9.19544C28.1008 9.23545 28.0861 9.25868 28.1157 9.25472C28.2015 9.22859 28.4098 9.19544 28.5023 9.14189C28.5897 9.09656 28.6932 8.87539 28.751 8.79288C28.8088 8.71055 28.8088 8.66918 28.7938 8.64753C28.735 8.61149 28.3837 8.57591 28.2002 8.62628C28.1492 8.66476 28.0497 8.86865 28.035 8.91115C28.0203 8.95365 28.0403 8.95087 28.1022 8.9358M27.0787 9.82172C26.9816 9.99138 27.1034 10.1283 27.1477 10.2653C27.0878 10.326 26.9957 10.2706 26.9649 10.2174C26.8994 10.1082 26.9213 9.88559 26.8442 9.8513C26.8245 9.91143 26.8116 9.97818 26.8116 9.97818C26.8116 9.97818 26.8703 10.1304 26.8556 10.2311C26.8462 10.292 26.7978 10.3631 26.7338 10.3645C26.5633 10.369 26.6472 10.0892 26.5815 9.93064C26.568 9.9694 26.5584 10.011 26.5427 10.0474C26.5547 10.0887 26.5613 10.1467 26.5633 10.1801C26.5671 10.2465 26.5624 10.3181 26.5726 10.3748C26.5868 10.455 26.6269 10.5082 26.6883 10.5134C26.8156 10.5246 26.8738 10.4103 26.8929 10.3164C26.9149 10.4121 27.0833 10.5175 27.1662 10.4001C27.276 10.2451 27.1882 10.1123 27.1319 9.96656C27.0913 9.85878 27.1031 9.78806 27.0787 9.82172ZM22.2928 9.37185C22.3016 9.4416 22.334 9.48926 22.3867 9.49646C22.4956 9.51176 22.5508 9.41576 22.5714 9.33598C22.5858 9.41939 22.7267 9.51754 22.8032 9.42024C22.9044 9.29149 22.8343 9.17329 22.792 9.04511C22.7618 8.95013 22.7748 8.88984 22.7524 8.91783C22.6614 9.05933 22.7606 9.18315 22.793 9.30328C22.7387 9.35264 22.6618 9.30084 22.6375 9.25392C22.5857 9.15674 22.614 8.96606 22.5492 8.93291C22.5297 8.98396 22.5158 9.04069 22.5158 9.04069C22.5158 9.04069 22.5596 9.17453 22.5426 9.26055C22.5321 9.31263 22.4874 9.37162 22.4319 9.37003C22.2851 9.36641 22.3694 9.12909 22.3192 8.98974C22.3062 9.02233 22.296 9.05803 22.2808 9.08817C22.2896 9.12461 22.2928 9.17453 22.2928 9.20372C22.2939 9.26106 22.2866 9.32221 22.2928 9.37185ZM25.7677 15.944C25.7841 15.9152 25.8202 15.836 25.8112 15.7819C25.8021 15.7278 25.7422 15.5021 25.6261 15.4455C25.5108 15.389 25.4235 15.5075 25.3682 15.6724L25.3298 15.6714C25.3207 15.6958 25.3092 15.7323 25.3001 15.7981C25.2872 15.8933 25.2629 15.9545 25.1157 16.1027C24.992 16.2266 24.591 16.5244 24.3312 16.6643C24.0711 16.8045 23.8839 16.9255 23.8149 16.9622C23.7462 16.9984 23.7662 17.0119 23.8349 16.9891C23.9035 16.9664 24.2487 16.8431 24.3864 16.7803C24.5237 16.717 24.6917 16.6129 24.8941 16.4673C25.1193 16.3054 25.2538 16.1436 25.299 16C25.3312 15.8978 25.3395 15.8568 25.3395 15.8568C25.3395 15.8568 25.424 15.9122 25.5675 15.9485C25.7105 15.985 25.7511 15.9732 25.7677 15.9441M25.5737 15.6234C25.6374 15.6502 25.6762 15.7271 25.6877 15.7738C25.6146 15.7756 25.48 15.7344 25.4228 15.7058C25.4572 15.6318 25.5171 15.5998 25.5737 15.6234Z" fill="white" />
                          <path d="M24.2441 16.1027C24.0444 16.072 23.5414 15.9872 23.4183 15.6635C23.5217 15.4964 23.9975 15.2849 24.5936 15.087C25.1897 14.8896 25.8126 14.6333 25.98 14.5096C26.0167 14.4958 26.0877 14.4999 26.0877 14.4999C26.1177 14.4042 26.2673 14.0681 26.2767 13.9979C26.1101 14.0083 25.0832 14.0919 24.6271 14.1191C24.1707 14.1463 23.2918 14.1398 22.9989 14.1361C23.1785 13.9929 23.6048 13.7134 24.2141 13.4749C24.2931 13.4439 24.3661 13.4159 24.4343 13.3907C24.485 13.4908 24.5226 13.5899 24.5305 13.6761C24.5693 13.6319 24.5984 13.4854 24.5886 13.335C24.9438 13.2093 25.1268 13.1676 25.2057 13.144C25.2555 13.0724 25.3439 12.7828 25.357 12.5722C25.304 12.4651 25.1378 12.3316 24.99 12.2169C24.7863 12.0592 24.5666 11.9217 24.3474 11.9819C24.0477 12.0634 23.9876 12.6738 24.0574 12.8033C24.0797 12.8442 24.1325 12.9167 24.1948 13.0061C23.9758 13.1015 23.7468 13.2137 23.5449 13.3317C23.0953 13.5943 22.5933 13.8816 22.4468 14.1578L22.4048 14.1805C22.393 14.2066 22.3003 14.6341 22.2869 14.6802C22.3804 14.6766 23.0787 14.678 23.5651 14.6613C24.0511 14.644 24.4762 14.6269 24.6427 14.6269C24.3961 14.6917 23.75 14.9578 23.5642 15.1144C23.3785 15.2714 23.2617 15.5101 23.2586 15.9192C23.0855 15.844 22.7636 15.6722 22.4893 15.261C22.1836 14.8026 22.2469 14.3312 22.1245 13.7125C21.9467 12.8148 21.567 12.0567 21.3306 11.8249C21.2509 12.1417 21.2407 12.3805 21.2407 12.3805C21.2407 12.3805 21.5369 13.1067 21.6869 13.5702C21.8368 14.0338 21.9649 14.4906 21.9586 14.5929C21.8351 14.8931 21.1042 15.522 20.4951 15.89C19.9174 16.2391 19.4086 16.2767 19.2282 16.0281C19.1928 15.9796 19.1688 15.9222 19.1552 15.8572C19.2336 15.8166 19.3122 15.7757 19.3929 15.7348C19.9123 15.4724 20.8347 14.9203 21.0509 14.6305C21.2841 14.2794 21.2809 13.785 21.1441 13.502C21.0079 13.2191 20.7942 12.8917 20.7776 12.7759C20.7646 12.7212 20.9163 12.7981 21.0059 12.8033C21.0493 12.7997 21.0276 12.735 20.9345 12.6326C20.8601 12.5512 20.5721 12.2867 20.462 12.1835C20.4344 12.1573 20.4139 12.1679 20.4083 12.1956C20.3868 12.3012 20.343 12.5274 20.3261 12.639L20.3379 12.6953C20.3695 12.7161 20.4059 12.7395 20.4235 12.7978C20.4485 12.8806 20.5357 13.1117 20.6786 13.4033C20.8218 13.6947 21.0287 14.0164 21.049 14.1789C20.8808 14.4169 20.0322 14.9235 19.2057 15.3411C19.2568 15.1655 19.3374 14.9669 19.4444 14.7463C19.4748 14.709 19.5025 14.663 19.5282 14.611C19.6107 14.444 19.6187 14.2398 19.5687 14.2829C19.5259 14.3287 19.4951 14.4945 19.446 14.5056C19.3457 14.5285 19.2048 14.3986 19.2403 14.1611C19.2724 13.9469 19.3757 13.7535 19.4203 13.6296C19.4822 13.4582 19.4991 13.2889 19.4522 13.381C19.3468 13.5868 19.149 13.9855 19.0883 14.264C19.0278 14.5421 19.092 14.7323 19.198 14.8059C19.2376 14.8339 19.2756 14.8426 19.3117 14.8371C19.2392 14.9901 19.1496 15.1778 19.0842 15.4017C18.7518 15.5666 18.4285 15.714 18.1607 15.8201C17.1986 16.2021 16.5129 16.427 16.0332 16.5941L16.0145 16.6034C16.0498 16.477 16.045 16.3691 16.0072 16.4015C15.9643 16.4476 15.9337 16.6133 15.8847 16.6242C15.7843 16.647 15.6435 16.5173 15.6787 16.2797C15.7109 16.0655 15.8143 15.8722 15.859 15.7483C15.9205 15.5771 15.9376 15.4074 15.8908 15.4998C15.7853 15.7055 15.5876 16.1042 15.5269 16.3826C15.4662 16.6608 15.5305 16.851 15.6363 16.9247C15.7682 17.0165 15.8806 16.9039 15.9668 16.7297L15.9971 16.6581C16.0271 16.6581 16.0776 16.6503 16.153 16.6317C16.3728 16.5769 16.9224 16.4885 17.6779 16.3793C18.2374 16.2986 18.6236 16.1282 18.997 15.9387C18.9951 15.9855 18.995 16.0324 18.9967 16.0792C19.017 16.6476 19.353 16.8081 19.8124 16.7017C20.2557 16.5986 20.8738 16.1479 21.2442 15.844C21.6305 15.5271 21.8533 15.244 21.9102 15.1453C22.0132 14.9032 22.0415 14.6357 22.0485 14.5095C22.0822 14.8571 22.1095 15.3381 22.406 15.7507C22.679 16.1304 23.2385 16.6602 24.2907 16.6747C24.2942 16.536 24.244 16.1027 24.244 16.1027M24.1745 12.5806C24.3251 12.3932 24.6465 12.5157 24.8878 12.7534C24.7641 12.7855 24.5963 12.8428 24.4111 12.9161C24.301 12.769 24.1783 12.6272 24.1745 12.5806M18.2589 10.011C18.3272 9.97645 18.5362 9.87219 18.7615 9.72672C18.9863 9.58222 19.1976 9.40712 19.3009 9.29073C19.3405 9.24613 19.3758 9.21123 19.3983 9.16975C19.4658 9.20074 19.5123 9.23293 19.5413 9.24557C19.5848 9.26421 19.6429 9.29101 19.6807 9.15354C19.7184 9.01624 19.6684 8.92755 19.5948 8.82164C19.5324 8.73279 19.4336 8.59934 19.3534 8.56619C19.2854 8.53791 19.253 8.70638 19.2634 8.70219H19.3089L19.3177 8.70695C19.224 8.75937 19.1515 8.9224 19.1442 8.97963C19.1368 9.04196 19.1474 9.08786 19.2819 9.12617L19.3359 9.14379C19.2238 9.29101 19.0148 9.44328 18.8723 9.55123C18.6703 9.70479 18.3836 9.89661 18.302 9.95203C18.2204 10.0071 18.2272 10.0246 18.2589 10.011ZM19.473 8.92925L19.4802 8.85564C19.5747 8.97504 19.6449 9.1171 19.6379 9.13722C19.5945 9.14107 19.5404 9.09659 19.4459 9.05182C19.4575 9.01172 19.4666 8.97076 19.473 8.92925ZM19.2016 8.92942C19.2011 8.90704 19.2374 8.84476 19.3145 8.81071C19.3913 8.77642 19.4254 8.87213 19.432 8.98864L19.4092 9.03533L19.3399 9.00876C19.2666 8.98496 19.217 8.97147 19.2016 8.92942Z" fill="white" />
                          <path d="M23.2973 12.2582C23.4082 12.177 23.713 11.9331 23.8859 11.7732C24.0061 11.6621 24.1474 11.4986 24.2433 11.3602C24.2983 11.3998 24.3542 11.4381 24.4107 11.475C24.5093 11.5389 24.5489 11.6336 24.5489 11.6336C24.5671 11.6026 24.6519 11.433 24.6188 11.3504C24.5988 11.3235 24.4777 11.245 24.3538 11.1609C24.4166 11.0045 24.5031 10.734 24.3792 10.6393C24.2733 10.5589 24.0945 10.6919 24.0117 10.8645C23.9434 11.0075 23.9345 11.1288 24.0649 11.228C24.1016 11.256 24.1367 11.2824 24.1712 11.3075C24.0397 11.467 23.7976 11.7029 23.6252 11.8634C23.4111 12.0621 23.2087 12.2568 23.1734 12.3033L23.1632 12.3214C23.1165 12.177 23.1292 12.088 23.0945 12.1358C22.9445 12.3966 23.1324 12.6079 23.2007 12.8188C23.1083 12.9117 22.9668 12.8264 22.9193 12.745C22.8182 12.5765 22.852 12.2344 22.7337 12.1815C22.7032 12.2739 22.6833 12.3768 22.6833 12.3768C22.6833 12.3768 22.7733 12.6111 22.7505 12.7658C22.7364 12.8594 22.6616 12.9689 22.5634 12.9708C22.3008 12.9782 22.4303 12.5475 22.3289 12.3035C22.3084 12.3633 22.2937 12.4273 22.269 12.4827C22.2876 12.5468 22.2979 12.6358 22.3005 12.6873C22.3073 12.7897 22.2997 12.8994 22.3152 12.9873C22.3369 13.1107 22.3988 13.1927 22.4933 13.2003C22.6892 13.218 22.7786 13.0415 22.8083 12.8976C22.842 13.0448 23.1015 13.2067 23.229 13.0262C23.398 12.7875 23.2627 12.5832 23.1763 12.3587L23.1661 12.3296C23.1782 12.3343 23.2234 12.3124 23.2973 12.2582ZM24.0634 10.9145C24.1283 10.7809 24.2651 10.7695 24.3062 10.8396C24.3387 10.8952 24.3414 11.0039 24.2924 11.1186C24.1718 11.0346 24.0641 10.9524 24.0634 10.9145Z" fill="white" />
                          <path d="M19.0213 11.409C18.7906 11.3908 18.6665 11.1565 18.5955 10.818C18.5244 10.4795 18.5679 10.0331 18.5872 9.91871C18.6065 9.80447 18.4978 9.86346 18.4555 10.1408C18.4135 10.4179 18.3712 10.8611 18.52 11.325C18.6686 11.7884 18.9218 11.9613 19.1437 11.902C19.3656 11.8431 19.5609 11.2657 19.6298 11.0067C19.6985 10.7476 20.0061 9.69068 20.1802 9.63384C20.2046 9.76344 20.0449 10.0884 19.9938 10.5771C19.943 11.0657 20.0314 11.7066 20.5909 11.8203C21.1503 11.9341 21.5298 11.5317 21.6675 11.252C21.8052 10.9727 21.8694 10.6791 21.885 10.5316C21.9029 10.9066 22.1336 11.4921 22.5817 11.6589C23.0147 11.8203 23.3456 11.6725 23.4917 11.4635C23.6215 11.2778 23.7272 10.8954 23.7363 10.602C23.7451 10.309 23.5167 9.77273 23.4655 9.602C23.4143 9.43166 23.3879 9.31339 23.3834 9.2544C23.379 9.19547 23.499 9.32274 23.5745 9.34768C23.6256 9.35901 23.6076 9.23633 23.5455 9.15206C23.4835 9.06814 23.1477 8.5038 23.1242 8.54307C23.1098 8.56658 22.9754 8.98178 22.9666 9.0453C23.0198 9.08406 23.0814 9.19082 23.086 9.29316C23.0902 9.39545 23.1791 9.84538 23.2613 10.0953C23.3435 10.3453 23.5032 10.8249 23.5144 10.9568C23.3547 11.0816 22.9949 11.2405 22.6532 11.0795C22.3114 10.9179 22.2024 10.6838 22.1647 10.2657C22.1406 9.99849 22.1382 9.50623 22.0523 9.09472C22.0039 8.86204 21.9018 8.62557 21.7806 8.5C21.7519 8.57707 21.6232 9.05222 21.6232 9.05222C21.6652 9.18856 21.7958 9.64761 21.7916 10.0454C21.787 10.4429 21.7587 10.8319 21.3567 11.1C20.9549 11.3681 20.3824 11.2613 20.2336 10.843C20.0848 10.4248 20.4155 9.48402 20.4113 9.23633C20.4068 8.98869 20.3666 8.95435 20.2735 8.99538C20.1802 9.03629 19.9891 9.27509 19.8251 9.66354C19.6607 10.0523 19.5878 10.4408 19.4943 10.7681C19.4011 11.0954 19.2521 11.4271 19.0213 11.409Z" fill="white" />
                          <path d="M29.8768 24.8775C29.8543 24.8061 29.7854 24.7538 29.7031 24.7538C29.6208 24.7538 29.5521 24.8061 29.5294 24.8775H28.7498C28.7417 24.7812 28.7499 24.6842 28.7741 24.5913L30.3837 24.5902L30.4286 24.674C30.4695 24.7497 30.5203 24.8183 30.5794 24.8774L29.8768 24.8775ZM30.9423 24.0481H29.008C29.1567 23.9291 29.2347 23.7556 29.2138 23.58C29.2004 23.4693 29.1015 23.3867 28.9809 23.3755H28.9204C28.7737 23.3913 28.6673 23.5086 28.6828 23.6373L28.6887 23.6868L28.6959 23.7629C28.704 23.8588 28.6958 23.9556 28.6718 24.0481H14.3741C14.5864 24.3906 14.9735 24.6006 15.3915 24.6003L28.4384 24.5914C28.2892 24.7105 28.211 24.8844 28.232 25.0603C28.2475 25.1891 28.3787 25.2808 28.5254 25.2649C28.6719 25.249 28.7783 25.1318 28.763 25.0029L28.7571 24.9536H29.5239C29.5373 25.0365 29.6121 25.1002 29.7031 25.1002C29.7941 25.1002 29.8689 25.0365 29.8825 24.9535H30.6625V24.9515C30.8253 25.0796 31.0323 25.1533 31.2513 25.1533C31.4572 25.1533 31.6241 24.9946 31.6241 24.7988V24.6964C31.6241 24.3384 31.319 24.0481 30.9424 24.0481" fill="white" />
                        </g>
                        <defs>
                          <clipPath id="clip0_flag_reg1">
                            <rect width="46" height="34" rx="8" fill="white" />
                          </clipPath>
                        </defs>
                      </svg>
                    </div>
                  </div>
                  <ErrorMsg name="s1Mobile" />
                </div>
              </div>

              {/* البريد الإلكتروني */}
              <div>
                <label style={lbl}>
                  البريد الإلكتروني <span style={{ color: '#EF4444' }}>*</span>
                </label>
                <input
                  type="email"
                  {...step1Form.register('s1Email')}
                  placeholder="name@gmail.com"
                  dir="ltr"
                  style={{ ...inp, textAlign: 'left', fontFamily: 'monospace', ...errStyle('s1Email') }}
                />
                <ErrorMsg name="s1Email" />
              </div>

              {/* مدينة الإقامة */}
              <div>
                <label style={lbl}>
                  مدينة الإقامة <span style={{ color: '#EF4444' }}>*</span>
                </label>
                <div style={{ position: 'relative' }}>
                  <select
                    {...step1Form.register('s1City')}
                    style={{ ...inp, appearance: 'none', paddingLeft: '40px', cursor: 'pointer', ...errStyle('s1City') }}
                  >
                    <option value="">أدخل مدينة</option>
                    {[
                      'الرياض',
                      'جدة',
                      'مكة المكرمة',
                      'المدينة المنورة',
                      'الدمام',
                      'الخبر',
                      'الطائف',
                      'تبوك',
                      'بريدة',
                      'الأحساء',
                      'حائل',
                      'أبها',
                      'نجران',
                      'جازان',
                      'عرعر',
                      'أخرى',
                    ].map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <div style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', fontSize: '12px', color: '#6B7280' }}>▼</div>
                </div>
                <ErrorMsg name="s1City" />
                {s1City === CITY_OTHER && (
                  <div style={{ marginTop: '12px' }}>
                    <label style={lbl}>
                      اسم المدينة <span style={{ color: '#EF4444' }}>*</span>
                    </label>
                    <input
                      type="text"
                      {...step1Form.register('s1CityOther')}
                      placeholder="أدخل اسم مدينتك"
                      dir="rtl"
                      style={{ ...inp, ...errStyle('s1CityOther') }}
                    />
                    <ErrorMsg name="s1CityOther" />
                  </div>
                )}
              </div>

              <NavRow showBack={false} />
            </div>
          )}

          {/* ─── STEP 2: معلومات الرخصة ─── */}
          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* 2-column: رقم رخصة فال + تاريخ انتهاء الرخصة */}
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '14px', direction: 'rtl' }}>
                {/* رقم رخصة فال — first = RIGHT */}
                <div>
                  <label style={lbl}>
                    رقم رخصة فال <span style={{ color: '#EF4444' }}>*</span>
                  </label>
                  <input
                    type="text"
                    {...step2Form.register('s2License')}
                    placeholder="أدخل رقم رخصة فال"
                    style={{ ...inp, ...errStyle('s2License') }}
                  />
                  <ErrorMsg name="s2License" />
                </div>
                {/* تاريخ انتهاء الرخصة */}
                <div>
                  <label style={lbl}>
                    تاريخ انتهاء الرخصة <span style={{ color: "#EF4444" }}>*</span>
                  </label>

                  <Controller
                    control={step2Form.control}
                    name="s2Expiry"
                    render={({ field }) => {
                      const selectedDate =
                        field.value && field.value.trim() !== ""
                          ? parse(field.value, "dd/MM/yyyy", new Date())
                          : null;

                      return (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "row",
                            alignItems: "stretch",
                            border: errors.s2Expiry
                              ? "1.5px solid #EF4444"
                              : "1.5px solid #D1D5DB",
                            borderRadius: "13px",
                            overflow: "hidden",
                            height: "52px",
                          }}
                        >
                          <div
                            style={{
                              flex: 1,
                            }}
                          >
                            <DatePicker
                              selected={selectedDate}
                              open={isExpiryCalendarOpen}
                              onClickOutside={closeExpiryCalendar}
                              onSelect={() => closeExpiryCalendar()}
                              onCalendarClose={closeExpiryCalendar}
                              dateFormat="dd/MM/yyyy"
                              placeholderText="jj/mm/aaaa"
                              className="custom-datepicker-input"
                              wrapperClassName="custom-datepicker-wrapper"
                              showPopperArrow={false}
                              shouldCloseOnSelect={true}
                              onChange={(date: Date | null) => {
                                if (!date) {
                                  field.onChange("");
                                  return;
                                }

                                field.onChange(format(date, "dd/MM/yyyy"));
                              }}
                            />
                          </div>

                          <div
                            onClick={openExpiryCalendar}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              padding: "0 14px",
                              background: "#F9FAFB",
                              borderRight: "1px solid #D1D5DB",
                              cursor: "pointer",
                              flexShrink: 0,
                              transition: ".2s",
                            }}
                          >
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="#6B7280"
                              strokeWidth="1.8"
                            >
                              <rect
                                x="3"
                                y="4"
                                width="18"
                                height="18"
                                rx="3"
                              />
                              <path
                                strokeLinecap="round"
                                d="M16 2v4M8 2v4M3 10h18"
                              />
                            </svg>
                          </div>
                        </div>
                      );
                    }}
                  />

                  <ErrorMsg name="s2Expiry" />
                </div>
              </div>

              {/* تحميل صورة الرخصة */}
              <div>
                <label style={{ ...lbl, marginBottom: '10px' }}>
                  تحميل صورة الرخصة <span style={{ color: '#EF4444' }}>*</span>
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,.pdf"
                  onChange={e => step2Form.setValue('s2File', e.target.files?.[0] ?? null, { shouldValidate: true, shouldTouch: true })}
                  style={{ display: 'none' }}
                />
                <div
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    border: isTouched('s2File') && errors.s2File ? '2px dashed #EF4444' : '2px dashed #B5C9C5',
                    borderRadius: '14px',
                    background: '#F4F7F6', padding: '36px 24px',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px',
                    cursor: 'pointer', transition: 'background 0.15s',
                  }}
                >
                  {s2File ? (
                    <>
                      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#1B7A5C" strokeWidth={1.8}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <p style={{ fontSize: '14px', fontWeight: 600, color: '#1B7A5C', margin: 0 }}>{s2File.name}</p>
                      <p style={{ fontSize: '12px', color: '#9CA3AF', margin: 0 }}>انقر للتغيير</p>
                    </>
                  ) : (
                    <>
                      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#1B7A5C" strokeWidth={1.8}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      <p style={{ fontSize: '14px', fontWeight: 600, color: '#111', margin: 0 }}>اختر ملف من جهازك</p>
                      <p style={{ fontSize: '12px', color: '#9CA3AF', margin: 0 }}>{`صورة (JPG, PNG) أو PDF – الحجم الأقصى: ${MAX_FILE_MB} MB`}</p>
                    </>
                  )}
                </div>
                <ErrorMsg name="s2File" />
              </div>

              <NavRow showBack={true} />
            </div>
          )}

          {/* ─── STEP 3: التخصص والخبرة ─── */}
          {step === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              {/* نوع العقار */}
              <div>
                <SectionHead
                  title="نوع العقار"
                  items={PROP_TYPES}
                  selected={s3Props}
                  onToggleAll={() => { selectAll(PROP_TYPES, s3Props, setS3Props); markTouched('s3Props'); }}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', direction: 'rtl' }}>
                  {PROP_TYPES.map(p => (
                    <Pill
                      key={p}
                      label={p === PROP_OTHER ? 'أخرى +' : p}
                      selected={s3Props.includes(p)}
                      onClick={() => { toggle(s3Props, setS3Props, p); markTouched('s3Props'); }}
                    />
                  ))}
                </div>
                <ErrorMsg name="s3Props" />
                {s3Props.includes(PROP_OTHER) && (
                  <div style={{ marginTop: '12px' }}>
                    <label style={lbl}>
                      نوع العقار الآخر <span style={{ color: '#EF4444' }}>*</span>
                    </label>
                    <input
                      type="text"
                      value={s3PropOther}
                      onChange={e => setS3PropOther(e.target.value)}
                      onBlur={() => markTouched('s3PropOther')}
                      placeholder="حدد نوع العقار"
                      dir="rtl"
                      style={{ ...inp, ...errStyle('s3PropOther') }}
                    />
                    <ErrorMsg name="s3PropOther" />
                  </div>
                )}
              </div>

              {/* مناطق التغطية */}
              <div>
                <SectionHead
                  title="مناطق التغطية"
                  items={REGIONS}
                  selected={s3Regions}
                  onToggleAll={() => { selectAll(REGIONS, s3Regions, setS3Regions); markTouched('s3Regions'); }}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', direction: 'rtl' }}>
                  {REGIONS.map(r => (
                    <Pill
                      key={r}
                      label={r === REGION_OTHER ? 'أخرى +' : r}
                      selected={s3Regions.includes(r)}
                      onClick={() => { toggle(s3Regions, setS3Regions, r); markTouched('s3Regions'); }}
                    />
                  ))}
                </div>
                <ErrorMsg name="s3Regions" />
              </div>

              {/* 2-column bottom: سنوات الخبرة + هل سبق */}
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '14px', direction: 'rtl' }}>
                {/* سنوات الخبرة — first = RIGHT */}
                <div>
                  <label style={lbl}>
                    سنوات الخبرة في مجال الاستشارات العقارية <span style={{ color: '#EF4444' }}>*</span>
                  </label>
                  <div style={{ position: 'relative' }}>
                    <select
                      value={s3Years}
                      onChange={e => { setS3Years(e.target.value); markTouched('s3Years'); }}
                      onBlur={() => markTouched('s3Years')}
                      style={{ ...inp, appearance: 'none', paddingLeft: '40px', cursor: 'pointer', ...errStyle('s3Years') }}
                    >
                      <option value="">اختر سنوات الخبرة</option>
                      {[
                        'أقل من سنة',
                        '1-2 سنة',
                        '3-5 سنوات',
                        '6-10 سنوات',
                        'أكثر من 10 سنوات',
                      ].map(y => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                    <div style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', fontSize: '12px', color: '#6B7280' }}>▼</div>
                  </div>
                  <ErrorMsg name="s3Years" />
                </div>

                {/* هل سبق — second = LEFT */}
                <div>
                  <label style={{ ...lbl, marginBottom: '12px' }}>
                    هل سبق لك كتابة تقارير عقارية؟ <span style={{ color: '#EF4444' }}>*</span>
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'row', gap: '10px', direction: 'rtl' }}>
                    {/* نعم — first = RIGHT */}
                    <button
                      type="button"
                      onClick={() => { setS3HasReports(true); markTouched('s3HasReports'); }}
                      style={{
                        flex: 1, height: '52px', borderRadius: '13px',
                        border: s3HasReports === true ? '1.5px solid #D4A853' : '1.5px solid #D1D5DB',
                        background: '#FFFFFF',
                        color: s3HasReports === true ? '#D4A853' : '#374151',
                        fontSize: '14px', fontWeight: s3HasReports === true ? 700 : 500,
                        cursor: 'pointer', fontFamily: 'Alexandria, sans-serif',
                      }}
                    >
                      نعم
                    </button>
                    {/* لا — second = LEFT */}
                    <button
                      type="button"
                      onClick={() => { setS3HasReports(false); markTouched('s3HasReports'); }}
                      style={{
                        flex: 1, height: '52px', borderRadius: '13px',
                        border: s3HasReports === false ? '1.5px solid #D4A853' : '1.5px solid #D1D5DB',
                        background: '#FFFFFF',
                        color: s3HasReports === false ? '#D4A853' : '#374151',
                        fontSize: '14px', fontWeight: s3HasReports === false ? 700 : 500,
                        cursor: 'pointer', fontFamily: 'Alexandria, sans-serif',
                      }}
                    >
                      لا
                    </button>
                  </div>
                  <ErrorMsg name="s3HasReports" />
                </div>
              </div>

              <NavRow showBack={true} />
            </div>
          )}

          {/* ─── STEP 4: التوفر والملف المهني ─── */}
          {step === 4 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              {/* الأيام المتاحة */}
              <div>
                <SectionHead
                  title="الأيام المتاحة للمساندة في إنتاج التقارير الاستشارية"
                  items={DAYS}
                  selected={s4Days}
                  onToggleAll={() => { selectAll(DAYS, s4Days, setS4Days); markTouched('s4Days'); }}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', direction: 'rtl' }}>
                  {DAYS.map(d => (
                    <Pill key={d} label={d} selected={s4Days.includes(d)} onClick={() => { toggle(s4Days, setS4Days, d); markTouched('s4Days'); }} />
                  ))}
                </div>
                <ErrorMsg name="s4Days" />
              </div>

              {/* الأشهر المتاحة */}
              <div>
                <SectionHead
                  title="الأشهر المتاحة لعمل التقارير الاستشارية"
                  items={MONTHS}
                  selected={s4Months}
                  onToggleAll={() => { selectAll(MONTHS, s4Months, setS4Months); markTouched('s4Months'); }}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', direction: 'rtl' }}>
                  {MONTHS.map(m => (
                    <Pill key={m} label={m} selected={s4Months.includes(m)} onClick={() => { toggle(s4Months, setS4Months, m); markTouched('s4Months'); }} />
                  ))}
                </div>
                <ErrorMsg name="s4Months" />
              </div>

              {/* نبذة مهنية مختصرة */}
              <div>
                <label style={lbl}>نبذة مهنية مختصرة (اختياري)</label>
                <textarea
                  value={s4Bio}
                  onChange={e => setS4Bio(e.target.value)}
                  onBlur={() => markTouched('s4Bio')}
                  placeholder="اكتب نبذة عن خبرتك المهنية هنا..."
                  rows={4}
                  maxLength={500}
                  style={{
                    width: '100%',
                    border: isTouched('s4Bio') && errors.s4Bio ? '1.5px solid #EF4444' : '1.5px solid #D1D5DB',
                    borderRadius: '13px',
                    padding: '14px 16px', fontSize: '14px', color: '#111',
                    background: '#FFFFFF', outline: 'none', resize: 'vertical',
                    fontFamily: 'Alexandria, sans-serif', textAlign: 'right',
                    boxSizing: 'border-box', lineHeight: 1.6,
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                  <ErrorMsg name="s4Bio" />
                  <span style={{ fontSize: '11px', color: '#9CA3AF', marginRight: 'auto' }}>{(s4Bio ?? '').length}/500</span>
                </div>
              </div>

              {/* رابط ملف LinkedIn */}
              <div>
                <label style={lbl}>رابط ملف LinkedIn (اختياري)</label>
                <div style={{
                  display: 'flex', flexDirection: 'row', alignItems: 'stretch',
                  border: '1.5px solid #D1D5DB', borderRadius: '13px',
                  overflow: 'hidden', height: '52px',
                  ...errStyle('s4Linkedin'),
                }}>
                  {/* URL input — first = RIGHT */}
                  <input
                    type="url"
                    value={s4Linkedin}
                    onChange={e => setS4Linkedin(e.target.value)}
                    onBlur={() => markTouched('s4Linkedin')}
                    placeholder="https://linkedin.com/in/..."
                    dir="ltr"
                    style={{ flex: 1, border: 'none', outline: 'none', padding: '0 12px', fontSize: '13px', color: '#111', background: 'transparent', fontFamily: 'monospace', textAlign: 'left', minWidth: 0 }}
                  />
                  {/* Link icon — second = LEFT */}
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: '0 14px', background: '#F9FAFB',
                    borderRight: '1px solid #D1D5DB', flexShrink: 0,
                  }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth={1.8}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  </div>
                </div>
                <ErrorMsg name="s4Linkedin" />
              </div>

              {/* الموافقة على الشروط والأحكام */}
              <div>
                <label dir="rtl" style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer', fontSize: '13px', color: '#374151', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    checked={s4Terms}
                    onChange={e => { setS4Terms(e.target.checked); markTouched('s4Terms'); }}
                    style={{ width: '16px', height: '16px', marginTop: '2px', cursor: 'pointer', accentColor: '#1B4332', flexShrink: 0 }}
                  />
                  <span>أوافق على <span style={{ color: '#1B4332', fontWeight: 600 }}>الشروط والأحكام</span> وسياسة الخصوصية</span>
                </label>
                <ErrorMsg name="s4Terms" />
              </div>

              <NavRow showBack={true} isLast={true} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
