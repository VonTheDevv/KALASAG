-- Remove rows accepted by the previous summary-driven classifier. Match both
-- publisher and exact headline so this corrective migration cannot delete a
-- later, unrelated incident with similar wording.

delete from public.news_articles as article
using (values
  ('gma-news', 'Sara Duterte impeachment trial Day 9: Prosecution rests case on alleged threat against Marcos'),
  ('abs-cbn-news', 'Go gives context of Sara Duterte punching a court sheriff in 2011'),
  ('daily-tribune', 'First Lady helps secure P37.5M Nitori aid for Mindanao quake victims'),
  ('daily-tribune', 'First Lady, Nitori lead P37.5M aid for Mindanao quake victims'),
  ('daily-tribune', 'Bong Go aids 372 families displaced by Tondo fire'),
  ('gma-news', 'Sara Duterte impeachment trial Day 9: What to expect'),
  ('abs-cbn-news', 'Hundreds flee as wildfire rips through southern France'),
  ('abs-cbn-news', '3 miyembro ng ''termite gang'' arestado sa panloloob ng tindahan sa Tarlac'),
  ('gma-news', 'Sara Duterte impeachment trial Day 8: Matibag stands by ''threat'' testimony, VP in The Hague'),
  ('gma-news', 'Suspect in Cavite shooting over billiards game arrested after a year in hiding'),
  ('gma-news', 'Philippine eagle na si Sawaga-Dalwangan, inatake nga ba mga unggoy o binaril ng tao?'),
  ('gma-news', 'Murdered UK politician Widdecombe hit with hammer 21 times, London court told'),
  ('abs-cbn-news', 'Marcos assures legal aid for families of slain seafarers'),
  ('gma-news', 'SC: Ransom money not required as evidence in kidnapping cases'),
  ('abs-cbn-news', 'SC: Money not essential to proving kidnapping for ransom'),
  ('gma-news', 'Naaksidenteng rider, natuklasang nakaw ang gamit na motor; plate number, nakaw din'),
  ('abs-cbn-news', 'Carnapper tiklo matapos maaksidente habang gamit ang nakaw na plaka'),
  ('gma-news', 'Flash floods kill 20 in Afghanistan, 100 missing, authorities say'),
  ('gma-news', 'Slain vlogger Mima Alicia leaves behind 4-year-old child; supporters mourn'),
  ('gma-news', 'Kapuso Tulay in CamSur rehabilitated after Typhoon Uwan'),
  ('daily-tribune', '50-year-old family driver arrested in stolen Mustang case'),
  ('abs-cbn-news', 'Burol ng pinaslang na vlogger, binuksan sa publiko'),
  ('gma-news', 'Mga labi ng Fil-Am airman na nasawi sa aksidente sa Vandenberg Space Force Base, iuuwi sa Pilipinas'),
  ('abs-cbn-news', 'Police probe prior threat against slain vlogger ''Mima Alicia'''),
  ('abs-cbn-news', 'Argentina, Spain fans flood New York as city bids farewell to World Cup'),
  ('daily-tribune', 'Biazon, nakiusap matapos ang sunog sa OsMun: Huwag i-post ang video ng mga pasyente'),
  ('abs-cbn-news', 'DPWH eyes completion of EDSA rehab next year, expands sidewalks, asphalt works'),
  ('abs-cbn-news', 'Volleyball: Aussies sweep Letran to open Shakey''s campaign'),
  ('daily-tribune', 'Romualdez camp: No evidence linking former speaker to flood control mess'),
  ('daily-tribune', 'Baguio to launch youth resilience boot camp after quake panic'),
  ('abs-cbn-news', 'Venezuela quake death toll exceeds 5,000 as IMF releases funds'),
  ('abs-cbn-news', '‘Godzilla’ actress Kaylee Hottle, 18, dies in US car crash'),
  ('gma-news', 'Marcos condemns China actions vs. Filipino troops in West PH Sea -- Palace'),
  ('abs-cbn-news', 'Mexican mayor shot dead in town hall')
) as rejected(source_id, title)
where article.source_id = rejected.source_id
  and article.title = rejected.title;
