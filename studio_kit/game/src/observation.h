/* Read-only provenance from executed arcade queue writes. No emulated state lives here.
 * Entry capture: 06088894, R14 = WORK, R13 = allocated queue node.
 * Flush capture: 06137048 / 061370FC, R0 = node, EA = main-list record.
 * Every other writer invalidates provenance rather than guessing an owner.
 */
#define OBS_CONSUMER_KEY 0x07e65cefc44270b4ull
enum { OBS_MAGIC = 0x3153424f, OBS_VERSION = 2, OBS_NODES = 1024, OBS_MAIN = 512 };
typedef struct {
    uint32_t valid, work, node, submitted, emitted;
    uint32_t work_id, object_id, type, charset, master;
    uint32_t script, script_index, cel, player_id, x, y, z;
    uint32_t record[3];
} ObservationOwner;
typedef struct {
    uint32_t magic, version, bytes, enabled;
    uint64_t consumer, images, checksum;
    ObservationOwner nodes[OBS_NODES], main[OBS_MAIN];
} ObservationState;
static ObservationState observation, observation_out;
static uint64_t observation_image_key;
static uint64_t observation_hash(const uint8_t *p,size_t n,uint64_t h) {
    while(n--)h=(h^*p++)*1099511628211ull;return h;
}
static void observation_images(void) {
    uint64_t h=observation_hash(rom,0x1000000,1469598103934665603ull);
    h=observation_hash(bios,0x80000,h);
    observation_image_key=observation_hash(data,data_size,h);
}
static uint64_t observation_consumer(void) {
    const uint32_t spans[3][2] = {{0x88888,0x88964},{0x884fa,0x88650},{0x136f90,0x137212}};
    uint64_t h = 1469598103934665603ull;
    if (!rom) return 0;
    for (unsigned i=0;i<3;i++) for (uint32_t a=spans[i][0];a<spans[i][1];a++) h=(h^rom[a])*1099511628211ull;
    return h;
}
static uint32_t observation_ram_word(const Sh2 *s, uint32_t address, unsigned size) {
    uint32_t a=address&~0x20000000u, v=0;
    if (a<SH2_RAM || a-SH2_RAM>SH2_RAM_SIZE-size) return 0;
    for (unsigned i=0;i<size;i++) v=(v<<8)|s->ram[a-SH2_RAM+i];
    return v;
}
static int observation_node(uint32_t address) {
    uint32_t a=(address&~0x20000000u)-0x0206AC94u;
    return a<OBS_NODES*20u && a%20u==0 ? (int)(a/20u) : -1;
}
static void observation_reset(void) {
    uint32_t enabled=observation.enabled;
    memset(&observation,0,sizeof observation);
    observation.magic=OBS_MAGIC;observation.version=OBS_VERSION;observation.bytes=sizeof observation;
    observation.consumer=observation_consumer();observation.images=observation_image_key;observation.enabled=enabled;
}
static void observation_access(Sh2 *s,uint32_t ea,int size,int write,uint32_t value) {
    (void)value;
    if (!observation.enabled || !write) return;
    uint32_t a=ea&~0x20000000u,pc=s->cur;
    if (a>=0x0206AC94u && a<0x0206FC94u) {
        unsigned i=(a-0x0206AC94u)/20u,field=(a-0x0206AC94u)%20u;
        ObservationOwner *o=&observation.nodes[i];
        if (pc==0x06088894u && size==2 && field==0 && (s->r[13]&~0x20000000u)==a) {
            uint32_t w=s->r[14]&~0x20000000u;
            memset(o,0,sizeof *o);
            if (w<SH2_RAM || w-SH2_RAM>SH2_RAM_SIZE-0x3C2u) return;
            o->valid=1;o->work=w;o->node=a;o->submitted=frame_no;
            o->work_id=observation_ram_word(s,w+6,2);o->object_id=observation_ram_word(s,w+8,2);
            o->type=observation_ram_word(s,w+4,1);o->charset=observation_ram_word(s,w+5,1);
            o->master=observation_ram_word(s,w+0x3B8,4);
            o->script=observation_ram_word(s,w+0x200,4);o->script_index=observation_ram_word(s,w+0x204,2);
            o->cel=observation_ram_word(s,w+0x21A,2);o->player_id=observation_ram_word(s,w+0x3C0,2);
            o->x=observation_ram_word(s,w+0x54,2);o->y=observation_ram_word(s,w+0x56,2);o->z=observation_ram_word(s,w+0x58,2);
        } else if (field<12 && !(pc>=0x06088894u && pc<=0x060888E6u) && pc!=0x060885C0u && pc!=0x060885E6u) o->valid=0;
        else if (field==18) o->valid=0;
    }
    if (a>=0x04000000u && a<0x04002000u) {
        unsigned i=(a-0x04000000u)/16u,field=(a-0x04000000u)%16u;
        ObservationOwner *o=&observation.main[i];
        static const uint32_t copies[2][6]={{0x06137048,0x06137054,0x06137060,0x0613706C,0x06137078,0x06137084},
                                          {0x061370FC,0x06137108,0x06137114,0x06137120,0x0613712C,0x06137138}};
        int known=size==2 && field<12 && !(field&1) && (pc==copies[0][field/2] || pc==copies[1][field/2]);
        if (!known) {o->valid=0;return;}
        if (field==0) {
            int node=observation_node(s->r[0]);
            memset(o,0,sizeof *o);
            if (node<0 || !observation.nodes[node].valid) return;
            *o=observation.nodes[node];o->emitted=frame_no;
            for (unsigned k=0;k<3;k++) o->record[k]=observation_ram_word(s,o->node+k*4u,4);
        }
    }
}
API(eng_observe) uint32_t eng_observe(uint32_t enabled) {
    observation_reset();
    observation.enabled=enabled && observation.consumer==OBS_CONSUMER_KEY;
    return observation.enabled;
}
API(eng_observation_owner) const ObservationOwner *eng_observation_owner(uint32_t main_word) {
    if (main_word%4 || main_word>=2048 || !observation.enabled) return NULL;
    ObservationOwner *o=&observation.main[main_word/4];
    if (!o->valid) return NULL;
    for (unsigned k=0;k<3;k++) if(video_spr(vm.machine.spr,main_word+k)!=o->record[k]) return NULL;
    return o;
}
static uint64_t observation_checksum(const ObservationState *state) {
    const uint8_t *p=(const uint8_t *)state;uint64_t h=1469598103934665603ull;
    const size_t skip=(const uint8_t *)&state->checksum-p;
    for(size_t i=0;i<sizeof *state;i++)h=(h^(i>=skip&&i<skip+8?0:p[i]))*1099511628211ull;
    return h;
}
API(eng_observation_size) uint32_t eng_observation_size(void) {return sizeof observation;}
API(eng_observation_save) const ObservationState *eng_observation_save(void) {
    observation_out=observation;observation_out.checksum=observation_checksum(&observation_out);return &observation_out;
}
API(eng_observation_restore) int eng_observation_restore(const ObservationState *in,uint32_t bytes) {
    if(bytes!=sizeof observation || in->magic!=OBS_MAGIC || in->version!=OBS_VERSION || in->bytes!=bytes || in->enabled>1 || (in->enabled && in->consumer!=OBS_CONSUMER_KEY) || in->consumer!=observation_consumer() || in->images!=observation_image_key || in->checksum!=observation_checksum(in))return -1;
    observation=*in;return 0;
}
