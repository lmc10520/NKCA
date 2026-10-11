import adsk.core, adsk.fusion, json, struct, array, time, os
def run(_c):
    app=adsk.core.Application.get(); D=app.activeProduct; r=D.rootComponent; A=D.attributes
    t0=time.time(); OUT=r'C:\Users\chihw\Documents\WWY_data'
    SKIP=('Print_Model','Plaza_Shell_Original','tmp_','Body62')
    bodies=[b for b in r.bRepBodies if not b.name.startswith(SKIP)]
    buf=bytearray(); views=[]; acc=[]; meshes=[]; nodes=[]; mats=[]; mi={}; man=[]
    def col(ap):
        if ap is None: return [0.7,0.7,0.7,1.0]
        c=None
        for p in ap.appearanceProperties:
            try:
                if p.objectType==adsk.core.ColorProperty.classType() and p.value:
                    v=p.value; c=[v.red/255.0,v.green/255.0,v.blue/255.0,1.0]; break
            except: pass
        if c is None: c=[0.7,0.7,0.7,1.0]
        if 'glass' in ap.name.lower(): c[3]=0.35
        return c
    def addview(b,target):
        while len(buf)%4: buf.append(0)
        off=len(buf); buf.extend(b)
        views.append({'buffer':0,'byteOffset':off,'byteLength':len(b),'target':target}); return len(views)-1
    n=0; tri=0
    for b in bodies:
        try:
            mc=b.meshManager.createMeshCalculator()
            mc.surfaceTolerance=2.5; mc.maxNormalDeviation=0.35
            m=mc.calculate()
            P=m.nodeCoordinatesAsFloat; N=m.normalVectorsAsFloat; I=m.nodeIndices
        except Exception as ex:
            man.append({'name':b.name,'err':str(ex)[:80]}); continue
        if len(I)==0: continue
        nv=len(P)//3
        pa=array.array('f',[0.0])*(nv*3); na=array.array('f',[0.0])*(nv*3)
        mn=[1e9]*3; mx=[-1e9]*3
        for i in range(nv):
            x=P[3*i]/100.0; y=P[3*i+2]/100.0; z=-P[3*i+1]/100.0
            pa[3*i]=x; pa[3*i+1]=y; pa[3*i+2]=z
            na[3*i]=N[3*i]; na[3*i+1]=N[3*i+2]; na[3*i+2]=-N[3*i+1]
            if x<mn[0]: mn[0]=x
            if y<mn[1]: mn[1]=y
            if z<mn[2]: mn[2]=z
            if x>mx[0]: mx[0]=x
            if y>mx[1]: mx[1]=y
            if z>mx[2]: mx[2]=z
        ia=array.array('I',I)
        vp=addview(pa.tobytes(),34962); vn=addview(na.tobytes(),34962); vi=addview(ia.tobytes(),34963)
        acc.append({'bufferView':vp,'componentType':5126,'count':nv,'type':'VEC3','min':mn,'max':mx})
        acc.append({'bufferView':vn,'componentType':5126,'count':nv,'type':'VEC3'})
        acc.append({'bufferView':vi,'componentType':5125,'count':len(I),'type':'SCALAR'})
        ap=b.appearance; an=ap.name if ap else 'default'
        if an not in mi:
            c=col(ap); mi[an]=len(mats)
            mt={'name':an,'pbrMetallicRoughness':{'baseColorFactor':c,'metallicFactor':0.0,'roughnessFactor':0.8},'doubleSided':True}
            if c[3]<1: mt['alphaMode']='BLEND'
            mats.append(mt)
        k=len(acc)
        meshes.append({'name':b.name,'primitives':[{'attributes':{'POSITION':k-3,'NORMAL':k-2},'indices':k-1,'material':mi[an]}]})
        nodes.append({'name':b.name,'mesh':len(meshes)-1,'extras':{'visible':b.isLightBulbOn,'appearance':an}})
        man.append({'name':b.name,'visible':b.isLightBulbOn,'appearance':an,'tris':len(I)//3})
        n+=1; tri+=len(I)//3
        if n%40==0: A.add('v6','log','glb %d/%d tris %d %ds'%(n,len(bodies),tri,time.time()-t0))
    while len(buf)%4: buf.append(0)
    g={'asset':{'version':'2.0','generator':'NKCA Fusion exporter'},'scene':0,'scenes':[{'nodes':list(range(len(nodes)))}],
       'nodes':nodes,'meshes':meshes,'materials':mats,'accessors':acc,'bufferViews':views,'buffers':[{'byteLength':len(buf)}]}
    js=json.dumps(g,separators=(',',':')).encode('utf8')
    while len(js)%4: js+=b' '
    with open(os.path.join(OUT,'nkca.glb'),'wb') as f:
        f.write(struct.pack('<III',0x46546C67,2,12+8+len(js)+8+len(buf)))
        f.write(struct.pack('<II',len(js),0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II',len(buf),0x004E4942)); f.write(buf)
    with open(os.path.join(OUT,'nkca_manifest.json'),'w',encoding='utf8') as f: json.dump(man,f,ensure_ascii=False)
    sets={}
    for s in D.selectionSets:
        nm=[]
        for e in s.entities:
            try: nm.append(e.name)
            except: pass
        sets[s.name]=sorted(set(nm))
    with open(os.path.join(OUT,'nkca_sets.json'),'w',encoding='utf8') as f: json.dump(sets,f,ensure_ascii=False)
    A.add('v6','log','glb done %d bodies tris %d size %.1fMB %ds'%(n,tri,len(buf)/1e6,time.time()-t0))
