/**
 * Lithuanian grocery-name TRIGRAM plausibility — learned from the project's
 * own hand-checkmarked truth corpus (2196 product names, all 5 chains, both
 * OCR platforms; regenerate with the snippet in the module docstring below
 * when the corpus grows substantially).
 *
 * Every truth name scores 0.000 implausibility (p99 = 0), while Apple-Vision
 * char-salad reads of PERFECTLY LEGIBLE print score 0.25-0.36
 * ("Coioa daminua maiato mamin" for "Sojos gaminys maisto gamin.",
 * ios-receipt-55). Diacritics are folded to base letters before scoring, so
 * OCR diacritic loss alone can never flag a name.
 *
 * Regenerate: fold each truth name (NFD, strip combining, lowercase), take
 * every [a-z]+ run, collect all 3-grams, sort, space-join.
 */
const TRIGRAM_DATA = 'aba abe abu aca acc ach aci ack aco act ada ade adi ado adr adu ady ael afa afe aff afi afl aga age agg agi agk ago agr agu ahl aic aid aik ail ain ais ait aiv aje aji ajo aka ake akl akm akn akt aku akv aky ala alb ald ale alg ali alk all alo alp alq als alt alu alv aly ama amb ame ami amo amp ams amu ana anb anc and ane ang ani ank ann ano ans ant anu apa ape api apl apo app apr aqu ara arb arc ard are arg ari ark arl arm arn aro arp arr ars art aru ary arz asa asi ask asl asm asr ass ast asu ata atc ate ati atl ato ats att atu aud aug aui auj auk aul aun auo auq aus aut ava ave avi avl avo avr avy axi ayr aza azd aze azi azo azu azy azz bac bah bai baj bal bam ban bar bas bat bea bec bel ber bia bie bik bil bin bio bir bis bit bla ble bli bly bol bon bra bre bri bro bru bsn buk bul bum buo bur but buz byn byr caf cai cak can cap car cat cav cci cea ceb ced ces cha che chi chl cho chy cia cid cij cil cin cio cip cit ciu ciy ckb cke ckm cla cle clu cod col com coo cor cos cri cru cry cti cto cuk cup cyz dai dal dam dan dap dar das dau day daz dea deg dek del den der des dez dfi dia dic did die din dio dis dob doj dol dom don dor dou dra dre dri dru due duk dum dun duo dur dva dyd dyn dys dyt dzi ead eal ean ear eat eba ebe ebu eci eck eco ect ecu eda ede edi edo edu edz eet eff efy ega egn egr egs egt egz eik eil ein eip eit eja eje eji eju eka eke eki ekl ekm eko eks ekt eku ela ele elg eli ell elm eln elo elp els elt ely ema eme emi emo emp emu ena end ene eng enh eni eno ens ent enu eny epa epe epi eps ept era ere erg eri erk erl erm ern ero err ers ert eru erv ery esa esc ese esi esk esl esm esn eso esp esq esr est esu eta ete eti etk etn eto etr ett etu eva eve evr ewa exi exp ext eza ezi ezo fae faj far fas fee fel ffa ffe fig fik fil fin fio fiz fli for fra fre fri fro fru fue fur fus fyr gab gag gai gal gam gar gas gat gav gaz gdo gel gem gen ger ges ggi ght gie gij gil gim gin gir gis giu giy gku gla gle gli gma gno goa gol gom goo gos got gra gre gri gru gry gst gti gub gui guj gun guo gur gus guz gva gyr gzo ham hap har hav haz hea hee hei her hev hia hig hil hin hip his hit hla hls hoc hol hor hou hyd iai ial iam ian iat iau ibe ibi ibs ica ice ich ici ick ico icu ida ide ido idr idu idy ieb iec ied iej iek iem ien ier ies iet iev iez ife ifl iga igd igh igi igl igm ign igu iia iie ija ijo iju ijy ika iki ikl iko iks iku iky ila ild ile ilg ili ilk ill iln ilt ilv ima imb ime imi iml imo imu ina inb ind ine ing ini inj ink ino ins int inu iny inz iob ioc ioj ion ios iot iov ipf ipi ipl ipo ipt ira ire irk irm irp irs irt iru isa isc ise ish isi isk iso isp iss ist isu ita ite iti itr itu ity iub iug iuj iuk ium iuo ius iuv iuz ive ivi ivu izi izu izz jal jan jas jau jav jeg jer jin jit joc jog jom jon jor jos jui juj jum jun juo jur jus kad kai kak kal kam kan kap kar kas kat kau kav kaz kbe kec kef kek kel kem ken kep ker kes ket kev kfu kia kib kie kil kin kio kis kiu kiv kiy kkf kla kle kli klo klu kly kma kme kmy knu kny kof koh koj kok kol kom kon kop kos kot kra kre kri kro kru kry ksa ksi ksl kst kta kte kto ktu kuc kuk kum kuo kur kut kuu kva kve kvi kys kyt lab lac lad lai lak lan lap laq lar las lat lau lav lax lay laz lbi lce lda ldu ldy ldz lea lec led leg lej lel lem len lep ler les let lev lga lgi lgo lgu lia lie lif lig lij lik lim lin lio lip liq lis lit liu liv liy liz lka lki lkl lko lla lle lli llm llo lls lma lme lmi lne lni lnu lod loe log loj lom lon los lot lou lov low loy lph lpr lsa lse lsi lta lte lti lto lty lub luk lum luo lus lut lux lve lvi lvn lvo lvy lyd lyj lyn lys lyv lzu mac mag mai maj mak mal mam man mar mas mat max may maz mbe mbi mbl mbo mbr mbu mby mec med meg mei mel men mer mes met mex mia mid mie mig mil min mio mir mis miu mix moj mol mon mor mos mot moz mpa mpe mpi mpo mpu msi mso msu mui mul mun muo mus myn nag nai nak nal nam nan nap nas nat nau nav nbi nbu nca nch nci nda nde ndi ndu ndz nea neg nei nej nek nel nem nen nep ner nes net nev nez nga ngl ngo ngs ngu ngv nho nia nic nid nie nig nij nil nim nin nio nis niu niv niy nja nka nkf nki nks noc noj nok nom non nos now nri nrt nse nsi nso nsu nta nti ntl nto ntp ntu nty nug nuk nul num nun nuo nus nut nyk nyp nys oat obe obr obu oce och oci ock oco oda ode odi odo odu ody oes oet off ofr oft oge ogg ogi ogo ogu oho oil oja oje oji ojo oju ojy oka oke oki oko okt ola olc old ole olg oli olo olu oly oma omb ome omi omo omp omu ona ond one oni onk ono ons onu ood ook oph opi opo opu ora ori ork orn oro orr ors ort oru ory osa osc osi oso ost osu osy ota ote oti otl oto otu otz oub our ous oux ova ove ovi owa owm oyd ozk ozz pad pae pai pak pam pan pap par pas pat pau pav pec pel pen pep per pes pet pfr phe phi pho pia pic pie pij pik pil pim pin pio pip pir pis pit piu piz pja pla ple pli plo plu poe pom pon pop pos pot ppi pra pre pri pro psi psn pta pti pto ptu pud pun puo pup pur pus put pyk pyn qri qua que qui quz rab rac rad raf rag rai rak ral ram ran ras rat rau rav raz rba rbu rde rdi rdz rea ree reg rei rek rel rem ren res ret rex rey rga rge rgo ria rib ric rie rig rij rik ril rim rin rio rip rir ris rit riu riy rka rki rko rkt rku rlu rme rmi rna rne rni rno rnt rnu rny rod roi rok rom ron ros rot rou rov rpi rpo rpy rre rry rsa rsb rsi rsk rst rta rte rti rto rtt rtu rua rud rug ruk rum run ruo rup rus rut ruz rva rve rvu ryb ryc ryd ryn rys ryt ryv ryz rze rzi rzo sai sak sal sam san sar sas sau sav sbr sby sca sch sci sco seb sek sel sem sen sep ser ses sha sia sic sid sie sif sik sil sim sin sio sir sis sit siu ska ske ski sko skr sku skv sky sla sle sli slo slu sly sma sme smi smu sna sne sni sod sof soj sok som son sos spa spe sph spi spr squ sra sre sri sry ssb ssi ssk sta ste sti stl sto str stu sty sua suc sud sug suh sul sum sun suo sup sur sus sut sva sve svi svo svy svz tac taf tag tai tal tam tan tar tas tat tau tch tea tec tei tej tek tel tem ten tep ter tes tet tex tib tic tie tij tik til tim tin tio tir tis tiv tke tla tle tli tno tof toj ton tor tos tot toz tpr tra tre tri tru try tsa tsi tte tti tua tui tuk tul tun tuo tur tus tut tuu tuv twi tyc tym tys tyt tyv ual uas uau uba ube ubl uci uda udi udo udu udy udz uel uet uga ugi ugu uhi uht uic uik uis uja uje uju ujy uka uki ukr uks ukt uku uky ule ulg uli ulk ulo ult ulu ulv ulz uma umb ume umi ump ums umu umy una unc une ung uni uno unu uob uod uog uoj uol uom uon uop uos uot upa upe upo uqu ura ure urg uri urk urn uro urt uru ury urz usa use usi usk usl usn usr ust usu usv uta ute uti uto utu uty uva uve uvi uza uzd uze uzi uzk uzr uzs uzt uzu uzy vad vaf vag vai vak val van var vas vaz ved vei vel vem ven ver ves vez via vic vid vie vig vij vik vil vim vin vio viq vir vis vit viu viy viz vnt vog vok von vos vre vro vuo vus vyk vyn vyr vys vyt wac wel whi win wma wow xic xpe xtr xxl ybi ybu yci yda yde ydi ydr ydy yel yje yka ykl yks ymi yna yne yni yno ynu ypl yra yri yro ysi ysn yst yta yte yti yto ytu yva yvi yvo yvu yzi zag zai zal zar zas zau zde zdi zdy zel zem zer zes zew zia zie zig zii zin zio ziu zka zku zky zny zod zol zom zot zov zri zsa zsp zte zuo zur zuv zva zyt zza zze';
const TRIGRAMS = new Set(TRIGRAM_DATA.split(' '));

const foldLt = (s: string): string =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Fraction of a name's letter-trigrams unseen in the truth corpus, and the
 * trigram count (confidence). Words shorter than 4 letters are skipped —
 * abbreviations ("vid.", "sk.") carry too little signal.
 */
export function nameImplausibility(name: string | undefined | null): { frac: number; n: number } {
    if (!name) return { frac: 0, n: 0 };
    let tot = 0;
    let bad = 0;
    for (const w of foldLt(name).match(/[a-z]+/g) ?? []) {
        if (w.length < 4) continue;
        for (let i = 0; i <= w.length - 3; i++) {
            tot++;
            if (!TRIGRAMS.has(w.slice(i, i + 3))) bad++;
        }
    }
    return { frac: tot > 0 ? bad / tot : 0, n: tot };
}

/** Flag threshold: ≥18% unseen trigrams over ≥8 trigrams — every legit truth
 *  name scores 0, the observed Vision char-salads score ≥0.25. */
export const nameLooksGarbled = (name: string | undefined | null): boolean => {
    const { frac, n } = nameImplausibility(name);
    return n >= 8 && frac >= 0.18;
};
